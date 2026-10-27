#!/usr/bin/env node
/* Ranger Hawk - the hunt forecast screen (docs/forecast.js), offline.

   Loads every script index.html loads into a VM with a stub DOM, a stub
   localStorage and a fetch that answers from docs/ (data files) or from a
   synthetic National Weather Service week built here. Nothing touches the
   network. Run:  node scraper/test_forecast.js

   The week: a warm Thursday and Friday, a snowstorm Saturday with a 15-degree
   fall and 5 inches of snow, a cold clear Sunday, a warm-up, and a hot
   Wednesday. The expected reads are worked by hand from the factor table in
   docs/forecast.js and research/2026-10-26_forecast-movement-evidence.md. */
'use strict';
process.env.TZ = 'America/Denver';
const fs = require('fs'), path = require('path'), vm = require('vm'), { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..'), DOCS = path.join(ROOT, 'docs');
const INDEX = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
const SPOT = { lat: 41.74, lon: -111.83, label: 'Cache, East Rich', kind: 'unit', id: 1 };
const NOW = Date.parse('2026-10-29T13:00:00Z');   // 7:00 am MDT, Thursday

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail ? '\n       got ' + String(detail).slice(0, 400) : ''));
}
const tick = () => new Promise(resolve => setImmediate(resolve));

/* ------------------------------------------------------- the NWS week ---- */
const DAYS = [
  { d: '2026-10-29', hi: 62, lo: 38, sf: 'Sunny', nsf: 'Clear', w: '5 mph', dir: 'S', pop: 0, am: 40, pm: 60 },
  { d: '2026-10-30', hi: 64, lo: 40, sf: 'Mostly Sunny', nsf: 'Partly Cloudy', w: '5 to 10 mph', dir: 'SW', pop: 10, am: 42, pm: 62 },
  { d: '2026-10-31', hi: 46, lo: 24, sf: 'Snow Showers Likely', nsf: 'Snow Showers', w: '15 to 25 mph', dir: 'NW', pop: 70, am: 44, pm: 30, snowIn: 5 },
  { d: '2026-11-01', hi: 44, lo: 20, sf: 'Sunny', nsf: 'Clear', w: '5 mph', dir: 'N', pop: 5, am: 24, pm: 42 },
  { d: '2026-11-02', hi: 55, lo: 28, sf: 'Sunny', nsf: 'Clear', w: '5 mph', dir: 'S', pop: 0, am: 30, pm: 54 },
  { d: '2026-11-03', hi: 58, lo: 30, sf: 'Mostly Sunny', nsf: 'Clear', w: '5 to 10 mph', dir: 'S', pop: 0, am: 32, pm: 56 },
  { d: '2026-11-04', hi: 72, lo: 35, sf: 'Sunny', nsf: 'Clear', w: '5 mph', dir: 'S', pop: 0, am: 40, pm: 70 }
];
const local = (d, h) => `${d}T${String(h).padStart(2, '0')}:00:00-06:00`;
function nwsPeriod(day, isDay) {
  return { name: isDay ? 'Daytime' : 'Night', startTime: local(day.d, isDay ? 6 : 18), endTime: local(day.d, isDay ? 18 : 23), isDaytime: isDay,
    temperature: isDay ? day.hi : day.lo, temperatureUnit: 'F', windSpeed: day.w, windDirection: day.dir,
    shortForecast: isDay ? day.sf : day.nsf, detailedForecast: (isDay ? day.sf : day.nsf) + ', with a high near ' + day.hi + '. ' + day.dir + ' wind ' + day.w + '.',
    probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: day.pop } };
}
function nwsWeek() {
  const periods = [], hourly = [], gust = [], snow = [];
  for (const day of DAYS) {
    periods.push(nwsPeriod(day, true), nwsPeriod(day, false));
    for (let h = 0; h < 24; h++) {
      const t = h < 8 ? day.am : h < 16 ? day.am + Math.round((day.pm - day.am) * (h - 8) / 8) : day.pm - Math.round((day.pm - day.lo) * (h - 16) / 8);
      hourly.push({ startTime: local(day.d, h), temperature: t, windSpeed: day.w.replace(/^\d+ to /, ''), windDirection: day.dir, shortForecast: day.sf, probabilityOfPrecipitation: { value: day.pop } });
    }
    const utc = Date.parse(local(day.d, 12));
    gust.push({ validTime: new Date(utc).toISOString().replace('.000Z', '+00:00') + '/PT6H', value: (parseInt(day.w.replace(/^\d+ to /, ''), 10) + 8) / 0.621371 });
    if (day.snowIn) snow.push({ validTime: new Date(utc).toISOString().replace('.000Z', '+00:00') + '/PT6H', value: day.snowIn * 25.4 });
  }
  return {
    points: { properties: { forecast: 'https://api.weather.gov/gridpoints/SLC/1,1/forecast', forecastHourly: 'https://api.weather.gov/gridpoints/SLC/1,1/forecast/hourly', forecastGridData: 'https://api.weather.gov/gridpoints/SLC/1,1', gridId: 'SLC', relativeLocation: { properties: { city: 'Logan', state: 'UT' } } } },
    forecast: { properties: { updateTime: '2026-10-29T09:30:00+00:00', periods } },
    hourly: { properties: { periods: hourly } },
    grid: { properties: { elevation: { unitCode: 'wmoUnit:m', value: 1800 }, windGust: { values: gust }, snowfallAmount: { values: snow }, quantitativePrecipitation: { values: [] } } }
  };
}

/* ------------------------------------------------------------ harness ---- */
async function app(opts = {}) {
  const store = new Map(Object.entries(opts.storage || {})), fetched = [], pending = [], opened = [], listeners = {};
  let renders = 0, currentTime = opts.now || NOW, online = !!opts.online;
  const element = id => { let html = ''; return { id, hidden: id === 'sheet', style: {}, dataset: {}, textContent: '', scrollTop: 0, classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, addEventListener() {}, focus() {}, setSelectionRange() {}, querySelectorAll() { return []; },
    get innerHTML() { return html; }, set innerHTML(v) { html = String(v); if (id === 'sheetin') opened.push(html); if (id === 'view') renders++; } }; };
  const elements = Object.fromEntries(['view', 'tabs', 'title', 'homesel', 'offline', 'sheet', 'sheetin'].map(id => [id, element(id)]));
  class TestDate extends Date { constructor(...a) { super(...(a.length ? a : [currentTime])); } static now() { return currentTime; } }
  const box = {
    console, Date: TestDate, Math, JSON, Object, Array, String, Number, RegExp, Promise, Set, Map, Intl, Error, isFinite, parseInt, parseFloat,
    URL, URLSearchParams, encodeURIComponent, decodeURIComponent, location: { href: 'https://rangerhawk.com/', search: '', reload() {} },
    setTimeout(fn) { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    document: { referrer: '', body: { classList: { toggle() {} } }, getElementById(id) { return elements[id] || null; },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, querySelectorAll() { return []; }, createElement() { return element('created'); }, head: { appendChild() {} } },
    window: { scrollTo() {}, addEventListener() {} },
    navigator: { get onLine() { return online; }, geolocation: { getCurrentPosition(success, failure) { if (opts.gpsFail) failure({ message: 'denied' }); else success({ coords: { latitude: 41.7, longitude: -111.6, accuracy: 8 } }); } } },
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    fetch(url) { fetched.push(String(url)); return new Promise((resolve, reject) => pending.push({ url: String(url), resolve, reject })); },
    Image: class { set src(v) {} }
  };
  vm.createContext(box);
  const scripts = [...INDEX.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(m => m[1]);
  for (const file of scripts) new vm.Script(fs.readFileSync(path.join(DOCS, file), 'utf8'), { filename: file, importModuleDynamically: () => Promise.reject(new Error('no dynamic import in the test')) }).runInContext(box);
  /* SUN is a top-level let in app.js: a global property would be shadowed, so assign the binding itself. */
  box.__sun = await import(pathToFileURL(path.join(DOCS, 'vendor', 'suncalc.js')).href);
  vm.runInContext('SUN = __sun;', box);
  vm.runInContext(`this.T = { FX, fxSpot, fxUnitSpot, fxKey, fxDays, fxSignal, fxOpeners, fxMoon, fxLoad, fxRecord, vForecast, fxSheetDay, fxSheetWhy, sheetUnit, unitsLoad, legalLight,
    state: () => ({ DB, UNITS, HU, tab, units }), setTab: v => { tab = v; }, setStatic: v => { units.static = v; }, setNow: v => { units.now = v; } };`, box);
  const week = opts.week || nwsWeek();
  async function flush() {
    for (let turn = 0, idle = 0; turn < 80 && idle < 3; turn++) {
      const batch = pending.splice(0); idle = batch.length ? 0 : idle + 1;
      for (const request of batch) {
        const u = request.url;
        if (u.startsWith('https://api.weather.gov/')) {
          if (!online) { request.reject(new Error('offline')); continue; }
          const body = u.includes('/points/') ? week.points : u.endsWith('/forecast/hourly') ? week.hourly : u.endsWith('/forecast') ? week.forecast : week.grid;
          if (opts.nwsFail && opts.nwsFail(u)) request.resolve({ ok: false, status: 500, json: async () => null });
          else request.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) });
          continue;
        }
        const file = path.resolve(DOCS, u.replace(/^\.\//, ''));
        if (!file.startsWith(DOCS + path.sep) || !fs.existsSync(file)) { request.resolve({ ok: false, status: 404, json: async () => null }); continue; }
        try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); request.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(value)) }); }
        catch (e) { request.reject(e); }
      }
      await tick();
    }
    if (pending.length) throw new Error('fetches did not settle: ' + pending.map(p => p.url).join(', '));
  }
  async function click(dataset) {
    const target = { dataset, closest(selector) { return Object.keys(dataset).some(k => selector.includes('[data-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) + ']')) ? this : null; } };
    for (const fn of listeners.click || []) fn({ target, preventDefault() {}, stopPropagation() {} });
    await flush();
  }
  await flush();   // app.js boot: the data files
  return { box, T: box.T, store, fetched, opened, elements, flush, click, week, scripts,
    renders: () => renders, setOnline: v => { online = v; }, setTime: t => { currentTime = t; } };
}

/* -------------------------------------------------------------- tests ---- */
(async () => {
  const sw = fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf8'), src = fs.readFileSync(path.join(DOCS, 'forecast.js'), 'utf8');
  const EMOJI = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u;
  ok('forecast.js carries no emoji', !EMOJI.test(src));
  ok('forecast.js never prints a movement percentage', !/\d+%\s*(High|Moderate|Low)|movement[^.]{0,40}%/i.test(src));
  ok('sw.js is v43 and lists forecast.js exactly once', /VERSION = 'ranger-hawk-v43'/.test(sw) && (sw.match(/'\.\/forecast\.js'/g) || []).length === 1);

  /* 1. Offline, nothing stored: no fetch, a plain explanation. */
  let S = await app({ online: false });
  ok('index.html loads forecast.js after units.js', S.scripts.indexOf('forecast.js') > S.scripts.indexOf('units.js'));
  S.T.setTab('forecast');
  let html = S.T.vForecast();
  ok('offline with nothing stored: says so and fetches nothing', /No signal, and no forecast/.test(html) && !S.fetched.some(u => u.includes('weather.gov')), html);
  ok('the species control shows mule deer and elk', /data-fxsp="deer"[^>]*aria-pressed="true"/.test(html) && /data-fxsp="elk"/.test(html));
  ok('the spot defaults to the home town', /Home: Salt Lake City/.test(html) && S.T.fxSpot().kind === 'town');

  /* 2. Online: the fetch chain, the stored record, and the week. */
  S = await app({ online: true });
  S.T.FX.spot = SPOT;
  S.T.setTab('forecast');
  html = S.T.vForecast();
  ok('first render while fetching says it is fetching', /Fetching the week/.test(html), html);
  await S.flush();
  const key = S.T.fxKey(SPOT);
  const wx = S.fetched.filter(u => u.includes('weather.gov'));
  ok('points, forecast, hourly and grid are fetched once each', wx.length === 4 && wx[0] === 'https://api.weather.gov/points/41.74,-111.83' && wx.some(u => u.endsWith('/forecast')) && wx.some(u => u.endsWith('/hourly')), wx.join(' '));
  const rec = S.T.fxRecord(key);
  ok('the record is stored on the phone under its spot key', rec && S.store.has('ha.fx.' + key) && JSON.parse(S.store.get('ha.fx.keys'))[0] === key);
  ok('the record keeps the forecaster\'s words, the grid URLs and the elevation in feet', rec.periods[0].df.startsWith('Sunny, with a high near 62') && rec.urls.office === 'SLC' && rec.elev === 5906, JSON.stringify(rec.urls));
  ok('grid gusts come back in mph and snow in inches', Math.round(rec.gust[2].v) === 33 && rec.snow[0].v === 5, JSON.stringify([rec.gust[2], rec.snow[0]]));

  const days = S.T.fxDays(rec, SPOT, NOW);
  ok('seven local days from today', days.length === 7 && days[0].key === '2026-10-29' && days[6].key === '2026-11-04' && days[0].name === 'Today' && days[2].name === 'Saturday', days.map(d => d.key + ' ' + d.name).join(', '));
  ok('high and low from the day and night periods, words from the day period', days[2].hi === 46 && days[2].lo === 24 && days[2].words === 'Snow Showers Likely' && days[2].nwords === 'Snow Showers');
  ok('wind takes the top of the range, gusts from the grid, snow summed by local day', days[2].wind === 25 && days[2].gust === 33 && days[2].snow === 5 && days[3].snow === 0, JSON.stringify([days[2].wind, days[2].gust, days[2].snow]));
  const L = days[0].light;
  ok('legal light is computed for the spot, in order, on whole minutes', L && L.start < L.sunrise && L.sunrise < L.sunset && L.sunset < L.late && L.start.getSeconds() === 0 && (L.sunrise - L.start) <= 31 * 60000 && (L.sunrise - L.start) >= 29 * 60000);
  const slc = S.T.legalLight(days[0].date);
  ok('the spot\'s sunrise differs from Salt Lake City\'s (not the Today card figure)', slc && Math.abs(slc.sunrise - L.sunrise) >= 60000, slc && (slc.sunrise - L.sunrise) / 60000);
  const M = days[0].moon;
  ok('moon phase has a name, a lit fraction and times', M && /^(New|Waxing crescent|First quarter|Waxing gibbous|Full|Waning gibbous|Last quarter|Waning crescent)$/.test(M.name) && M.frac >= 0 && M.frac <= 100 && (M.rise === null || M.rise instanceof Date), JSON.stringify(M));

  /* 3. The read, worked by hand from the factor table. */
  const sig = days.map((d, i) => S.T.fxSignal(days, i, 'deer', NOW));
  const names = s => s.factors.map(f => f.k + (f.dir > 0 ? '+' : f.dir < 0 ? '' : '~') + f.dir).join(' ');
  ok('Thursday, nothing special: Fair, no factors, first light', sig[0].tier === 'Fair' && sig[0].factors.length === 0 && sig[0].best.when === 'dawn' && /^from \d/.test(sig[0].best.window), names(sig[0]) + ' ' + sig[0].best.window);
  ok('Saturday: cold front (weak, +1), storm snow (strong, +1), hard freeze (strong, +1), wind shown not scored: Strong', sig[2].tier === 'Strong' && sig[2].score === 3 && names(sig[2]) === 'Hard freeze+1 Storm snow+1 Cold front+1 Wind~0', names(sig[2]));
  ok('Saturday\'s front arrives by day, so the window is last light', sig[2].best.when === 'dusk' && /colder than mid-morning/.test(sig[2].best.why), sig[2].best.why);
  ok('every factor carries a confidence word and a reason', sig.every(s => s.factors.every(f => /^(strong|moderate|weak|contested)$/.test(f.conf) && f.why.length > 20)));
  ok('the cold front says its evidence is whitetail, not mule deer or elk', /whitetails, none on mule deer or elk/.test(sig[2].factors.find(f => f.k === 'Cold front').why));
  ok('Sunday: rut shoulder (+1), hard freeze (+1), clearing after the storm (+1): Strong', sig[3].tier === 'Strong' && names(sig[3]) === 'Rut+1 Hard freeze+1 Clearing after the storm+1', names(sig[3]));
  ok('Monday: rut (+1) against an 11-degree warm-up (-1): Fair', sig[4].tier === 'Fair' && names(sig[4]) === 'Rut+1 Warm-up-1', names(sig[4]));
  ok('Wednesday at 72: rut, warm-up and a warm day: Fair, and the warm day says 70 is a rule of thumb', sig[6].tier === 'Fair' && names(sig[6]) === 'Rut+1 Warm-up-1 Warm day-1' && /rule of thumb/.test(sig[6].factors[2].why), names(sig[6]));
  const elk = days.map((d, i) => S.T.fxSignal(days, i, 'elk', NOW));
  ok('for elk: no November rut, Saturday still Strong, Wednesday Slow at 72 (warm from 65)', elk[2].tier === 'Strong' && elk[3].factors.every(f => f.k !== 'Rut') && elk[6].tier === 'Slow' && elk[6].who === 'Elk', names(elk[6]));
  ok('after mid-morning today, the window becomes last light', S.T.fxSignal(days, 0, 'deer', Date.parse('2026-10-29T18:00:00Z')).best.when === 'dusk');
  const dark = S.T.fxSignal(days, 0, 'deer', Date.parse('2026-10-30T04:00:00Z'));
  ok('after dark today, the window is first light tomorrow, from tomorrow\'s start', dark.when !== 'dawn' && dark.best.label === 'First light tomorrow' && dark.best.window === 'from ' + vm.runInContext('clock', S.box)(days[1].light.start), JSON.stringify(dark.best));

  /* 4. Opening days from seasons.json. */
  ok('the general rifle deer opener counts on the day and the two after, not the fourth', S.T.fxOpeners('2026-10-17', 'deer').some(s => s.id === 'deer-rifle') && S.T.fxOpeners('2026-10-19', 'deer').some(s => s.id === 'deer-rifle') && !S.T.fxOpeners('2026-10-20', 'deer').length, JSON.stringify(S.T.fxOpeners('2026-10-20', 'deer').map(s => s.id)));
  ok('the extended archery hunts never count as an opener', !S.T.fxOpeners('2026-09-12', 'deer').length && !S.T.fxOpeners('2026-08-15', 'elk').some(s => /ext/.test(s.id)));
  const openerDay = { key: '2026-10-17', hi: 60, lo: 35, pop: 0, snow: 0, wind: 5, gust: null, hours: [], light: null, moon: null, name: 'Saturday' };
  const openerSig = S.T.fxSignal([openerDay], 0, 'deer', NOW);
  ok('an opener scores -1 for deer (moderate) and names the hunt and the roads', openerSig.factors[0].k === 'Opening days' && openerSig.factors[0].dir === -1 && openerSig.factors[0].conf === 'moderate' && /Buck deer - any legal weapon \(rifle\) opened today/.test(openerSig.factors[0].why) && /away from the roads/.test(openerSig.factors[0].why), JSON.stringify(openerSig.factors[0]));
  const elkOpener = S.T.fxSignal([{ ...openerDay, key: '2026-10-04' }], 0, 'elk', NOW);
  const elkOpen = elkOpener.factors.find(f => f.k === 'Opening days');
  ok('an elk opener is strong, beside the rut shoulder', elkOpen && elkOpen.conf === 'strong' && elkOpen.dir === -1 && /tenth of a herd/.test(elkOpen.why) && elkOpener.factors[0].k === 'Rut', JSON.stringify(elkOpener.factors));

  /* 5. The screen. */
  html = S.T.vForecast();
  ok('the hero names the spot, the tier in words and the window', /Cache, East Rich/.test(html) && /Fair day for deer/.test(html) && /First light, from \d/.test(html), html.slice(0, 600));
  ok('seven day rows, each tapping to its day, coloured by tier', (html.match(/data-fx="day:\d"/g) || []).length === 8 && /data-fx="day:2" style="--g:var\(--elk\)"/.test(html) && /Saturday Oct 31 &middot; Strong/.test(html), html);
  ok('the source line names the Weather Service, the office, the grid cell and when it was issued and fetched', /National Weather Service, SLC office, grid cell near Logan, UT at 5,906 ft, issued .*; fetched/.test(html), html.slice(html.indexOf('Forecast: National')).slice(0, 300));
  ok('legal light is labelled an estimate and points at the guidebook', /Legal light today &middot; estimate/.test(html) && /guidebook table by county is the legal one/.test(html) && /Computed for the centre of Cache, East Rich/.test(html));
  ok('the moon card says it is not scored', /Moon<\/div>/.test(html) && /not scored/.test(html));
  ok('no percentage sits beside the movement read', !/(Strong|Good|Fair|Slow)[^<]{0,20}\d+%/.test(html) && !/\d+% (High|Moderate|Low)/.test(html));
  ok('the why sheet repeats the table with confidence words and the sources', /First and last light &middot; strong/.test(S.T.fxSheetWhy()) && /Barometric pressure &middot; contested/.test(S.T.fxSheetWhy()) && /Rittenhouse/.test(S.T.fxSheetWhy()) && /never claims a percentage/.test(S.T.fxSheetWhy()));
  const day2 = S.T.fxSheetDay(2);
  ok('a day sheet: stats, the factors, first and last light hour by hour, the forecaster\'s words', /Saturday, Oct 31/.test(day2) && /Cold front &middot; weak/.test(day2) && /First light, hour by hour/.test(day2) && /Last light<\/div>/.test(day2) && /In the forecaster's words/.test(day2) && /Snow Showers Likely, with a high near 46/.test(day2), day2.slice(0, 400));
  ok('the day sheet shows hourly rows for the dawn window', (day2.match(/<tr>/g) || []).length >= 6, (day2.match(/<tr>/g) || []).length);
  await S.click({ fxsp: 'elk' });
  ok('tapping Elk re-reads the week and saves the choice', S.T.FX.species === 'elk' && JSON.parse(S.store.get('ha.fx')).species === 'elk' && /Strong day for elk|Fair day for elk/.test(S.elements.view.innerHTML));
  await S.click({ fx: 'day:6' });
  ok('tapping a day opens its sheet', /Wednesday, Nov 4/.test(S.opened[S.opened.length - 1]) && /Slow day for elk/.test(S.opened[S.opened.length - 1]));

  /* 6. The stored week survives a lost signal, and the age is said. */
  const stored = Object.fromEntries(S.store);
  S = await app({ online: false, storage: stored, now: NOW + 5 * 3600000 });
  S.T.setTab('forecast');
  html = S.T.vForecast();
  ok('offline with a stored week: no fetch, the week shows, the warning says how old it is', !S.fetched.some(u => u.includes('weather.gov')) && /No signal: this is the forecast fetched 5 h ago/.test(html) && (html.match(/data-fx="day:\d"/g) || []).length === 8, html.slice(0, 500));
  ok('the hero says when it was fetched once the week is stale', /fetched 5 h/.test(html));

  /* 7. The weather service failing: one retry, then the stored week with a note. */
  let calls = 0;
  S = await app({ online: true, storage: stored, now: NOW + 5 * 3600000, nwsFail: u => { if (u.endsWith('/forecast')) { calls++; return true; } return false; } });
  S.T.setTab('forecast');
  S.T.vForecast(); await S.flush();
  html = S.T.vForecast();
  ok('a 500 from the forecast is retried once, and the stored week stays up with a try-again', calls === 2 && /Could not refresh: weather service answered 500/.test(html) && /data-fx="refresh"/.test(html) && (html.match(/data-fx="day:\d"/g) || []).length === 8, calls + ' ' + html.slice(0, 400));
  ok('the grid URLs were reused, so points was not fetched again', !S.fetched.some(u => u.includes('/points/')));

  /* 8. Spots: GPS, a unit, an access point, the town. */
  S = await app({ online: false });
  S.T.setTab('today');
  await S.click({ fx: 'gps' });
  ok('Where I am sets a GPS spot and opens the screen', S.T.FX.spot && S.T.FX.spot.kind === 'gps' && S.T.FX.spot.lat === 41.7 && S.T.state().tab === 'forecast', JSON.stringify(S.T.FX.spot));
  await S.click({ fx: 'at:40.5,-111.2', fxlabel: 'Soapstone Basin' });
  ok('an access point sets a named spot', S.T.FX.spot.kind === 'point' && S.T.FX.spot.label === 'Soapstone Basin' && S.T.FX.spot.lon === -111.2);
  await S.click({ fx: 'town' });
  ok('Home goes back to the town', S.T.FX.spot === null && S.T.fxSpot().kind === 'town');
  S = await app({ online: false, gpsFail: true });
  S.T.setTab('forecast');
  await S.click({ fx: 'gps' });
  ok('a refused GPS fix is said, not swallowed', /No GPS fix: denied/.test(S.elements.view.innerHTML), S.elements.view.innerHTML.slice(0, 300));

  S = await app({ online: false });
  const loading = S.T.unitsLoad(); await S.flush(); await loading; await S.flush();
  const st = S.T.state();
  const unit = (st.UNITS || []).find(u => u.n === 'Cache, East Rich') || (st.UNITS || [])[0];
  ok('unit shapes and hunt lists load for the unit sheet', !!unit && !!st.HU, unit && unit.n);
  if (unit) {
    const spot = S.T.fxUnitSpot(unit);
    ok('a unit\'s weather spot sits inside its box and carries its name', spot.lat >= unit.bb[1] && spot.lat <= unit.bb[3] && spot.lon >= unit.bb[0] && spot.lon <= unit.bb[2] && spot.label === unit.n && spot.kind === 'unit', JSON.stringify(spot));
    const sheet = S.T.sheetUnit(unit.id);
    ok('the unit sheet offers the forecast in the app', sheet.includes(`data-fx="unit:${unit.id}"`) && /7-day hunt forecast for this unit/.test(sheet));
    S.T.setStatic(true);
    ok('the static page renderer leaves the button out', !S.T.sheetUnit(unit.id).includes('data-fx='));
    S.T.setStatic(false);
    await S.click({ fx: 'unit:' + unit.id });
    ok('tapping it sets the unit as the spot and opens the screen', S.T.FX.spot && S.T.FX.spot.id === unit.id && S.T.state().tab === 'forecast');
  }
  const today = S.T.state();
  S.T.setTab('today');
  ok('the Today screen offers the forecast', /data-fx="open">Hunt forecast/.test(vm.runInContext('vToday()', S.box)));
  ok('the Menu lists it', vm.runInContext("GO_DEST.some(d => d.id === 'forecast' && d.tab === 'forecast' && d.keys.includes('weather'))", S.box));

  console.log(`test_forecast: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  ERROR ' + (e && e.stack || e)); process.exit(1); });
