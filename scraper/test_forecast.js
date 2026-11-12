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
const INDEX = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');   // what a browser loads: a tag inside an HTML comment is text, not a script
const SPOT = { lat: 41.74, lon: -111.83, label: 'Cache, East Rich', kind: 'unit', id: 1 };
const NOW = Date.parse('2026-10-29T13:00:00Z');   // 7:00 am MDT, Thursday

let pass = 0, fail = 0, finished = false;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail ? '\n       got ' + String(detail).slice(0, 400) : ''));
}
const tick = () => new Promise(resolve => setImmediate(resolve));
/* An await that never settles (a fetch nobody answered) drains the event loop and Node exits 0
   in silence, which the nightly would read as green. Say so and fail instead. */
process.on('beforeExit', () => { if (!finished) { console.log('  ERROR test_forecast ended before its last check: an await never settled (' + pass + ' passed so far)'); process.exit(1); } });

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
/* NWS writes local times with the offset in force: mountain daylight time to October 31, standard time from November 1. */
const local = (d, h) => `${d}T${String(h).padStart(2, '0')}:00:00${d >= '2026-11-01' ? '-07:00' : '-06:00'}`;
const shift = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
function nwsPeriod(day, isDay) {
  return { name: isDay ? 'Daytime' : 'Night', startTime: local(day.d, isDay ? 6 : 18), endTime: local(day.d, isDay ? 18 : 23), isDaytime: isDay,
    temperature: isDay ? day.hi : day.lo, temperatureUnit: 'F', windSpeed: day.w, windDirection: day.dir,
    shortForecast: isDay ? day.sf : day.nsf, detailedForecast: (isDay ? day.sf : day.nsf) + ', with a high near ' + day.hi + '. ' + day.dir + ' wind ' + day.w + '.',
    probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: day.pop } };
}
function nwsWeek(list = DAYS) {
  const periods = [], hourly = [], gust = [], snow = [];
  for (const day of list) {
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
  const store = new Map(Object.entries(opts.storage || {})), fetched = [], pending = [], opened = [], pixels = [], listeners = {};
  let renders = 0, currentTime = opts.now || NOW, online = !!opts.online;
  const element = id => { let html = ''; return { id, hidden: id === 'sheet', style: {}, dataset: {}, textContent: '', scrollTop: 0, classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, addEventListener() {}, focus() {}, setSelectionRange() {}, querySelectorAll() { return []; },
    get innerHTML() { return html; }, set innerHTML(v) { html = String(v); if (id === 'sheetin') opened.push(html); if (id === 'view') renders++; } }; };
  const elements = Object.fromEntries(['view', 'tabs', 'title', 'homesel', 'offline', 'sheet', 'sheetin'].map(id => [id, element(id)]));
  class TestDate extends Date { constructor(...a) { super(...(a.length ? a : [currentTime])); } static now() { return currentTime; } }
  const box = {
    console, Date: TestDate, Math, JSON, Object, Array, String, Number, RegExp, Promise, Set, Map, Intl, Error, isFinite, parseInt, parseFloat,
    URL, URLSearchParams, encodeURIComponent, decodeURIComponent, location: { href: 'https://rangerhawk.com/', search: opts.search || '', reload() {} },
    setTimeout(fn) { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    document: { referrer: '', body: { classList: { toggle() {} } }, getElementById(id) { return elements[id] || null; },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, querySelectorAll() { return []; }, createElement() { return element('created'); }, head: { appendChild() {} } },
    window: { scrollTo() {}, addEventListener() {} },
    navigator: { get onLine() { return online; }, geolocation: { getCurrentPosition(success, failure) { if (opts.gpsFail) failure({ message: 'denied' }); else success({ coords: { latitude: 41.7, longitude: -111.6, accuracy: 8 } }); } } },
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    fetch(url) { fetched.push(String(url)); return new Promise((resolve, reject) => pending.push({ url: String(url), resolve, reject })); },
    Image: class { set src(v) { pixels.push(String(v)); } }   // the visitor-count and event pixels: recorded, never sent
  };
  vm.createContext(box);
  const scripts = [...INDEX.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(m => m[1]);
  for (const file of scripts) {
    let code = fs.readFileSync(path.join(DOCS, file), 'utf8');
    if (file === 'site.js' && opts.counter !== undefined) code = code.replace(/const COUNTER_CODE = '[^']*';/, 'const COUNTER_CODE = ' + JSON.stringify(opts.counter) + ';');
    new vm.Script(code, { filename: file, importModuleDynamically: () => Promise.reject(new Error('no dynamic import in the test')) }).runInContext(box);
  }
  /* SUN is a top-level let in app.js: a global property would be shadowed, so assign the binding itself. */
  box.__sun = await import(pathToFileURL(path.join(DOCS, 'vendor', 'suncalc.js')).href);
  vm.runInContext('SUN = __sun;', box);
  vm.runInContext(`this.T = { FX, fxSpot, fxUnitSpot, fxKey, fxDays, fxSignal, fxOpeners, fxMoon, fxLoad, fxRecord, vForecast, fxSheetDay, fxSheetWhy, sheetUnit, unitsLoad, legalLight, vPrivacy, fxUnitParam, fxOpenLink, fxGauge,
    state: () => ({ DB, UNITS, HU, tab, units }), setTab: v => { tab = v; }, setStatic: v => { units.static = v; }, setNow: v => { units.now = v; },
    fxResetParam: () => { fxParamRead = false; fxParam = null; fxParamOpened = false; } };`, box);
  if (opts.static) vm.runInContext('units.static = true;', box);   // a static renderer from the first script on, as build_pages has it
  const week = opts.week || nwsWeek();
  async function flush() {
    for (let turn = 0, idle = 0; turn < 80 && idle < 3; turn++) {
      const batch = pending.splice(0); idle = batch.length ? 0 : idle + 1;
      for (const request of batch) {
        const u = request.url;
        if (u.startsWith('https://api.weather.gov/')) {
          if (!online) { request.reject(new Error('offline')); continue; }
          const body = u.includes('/points/') ? week.points : u.endsWith('/forecast/hourly') ? week.hourly : u.endsWith('/forecast') ? week.forecast : week.grid;
          const failed = opts.nwsFail && opts.nwsFail(u);
          if (failed) request.resolve({ ok: false, status: typeof failed === 'number' ? failed : 500, json: async () => null });
          else request.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) });
          continue;
        }
        if (opts.snow && /\/snow\.json$/.test(u)) { request.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(opts.snow)) }); continue; }
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
  return { box, T: box.T, store, fetched, opened, pixels, elements, flush, click, week, scripts,
    renders: () => renders, setOnline: v => { online = v; }, setTime: t => { currentTime = t; } };
}

/* -------------------------------------------------------------- tests ---- */
(async () => {
  const sw = fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf8'), src = fs.readFileSync(path.join(DOCS, 'forecast.js'), 'utf8');
  const EMOJI = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u;
  ok('forecast.js carries no emoji', !EMOJI.test(src));
  ok('sw.js is v46 and lists forecast.js exactly once', /VERSION = 'ranger-hawk-v46'/.test(sw) && (sw.match(/'\.\/forecast\.js'/g) || []).length === 1);

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
  ok('moon phase has a name, a lit fraction and real rise and set times', M && /^(New|Waxing crescent|First quarter|Waxing gibbous|Full|Waning gibbous|Last quarter|Waning crescent)$/.test(M.name) && M.frac >= 0 && M.frac <= 100 && days.filter(d => d.moon && d.moon.rise && d.moon.set && !isNaN(d.moon.rise.getTime())).length >= 5, JSON.stringify(M));

  /* 3. The read, worked by hand from the factor table. */
  const sig = days.map((d, i) => S.T.fxSignal(days, i, 'deer', NOW));
  const names = s => s.factors.map(f => f.k + (f.dir > 0 ? '+' : f.dir < 0 ? '' : '~') + f.dir).join(' ');
  ok('Thursday, nothing special: Fair, no factors, first light from about the start', sig[0].tier === 'Fair' && sig[0].factors.length === 0 && sig[0].best.when === 'dawn' && /^from about \d/.test(sig[0].best.window), names(sig[0]) + ' ' + sig[0].best.window);
  ok('Saturday: hard freeze (strong, +1), snow shown not scored, cold front (weak, +1), wind shown not scored: Good', sig[2].tier === 'Good' && sig[2].score === 2 && names(sig[2]) === 'Hard freeze+1 Snow in the forecast~0 Cold front+1 Wind~0', names(sig[2]));
  ok('snow in the forecast says the push is snow on the ground, read from the nearest gauge within 25 miles in season', /reads from the nearest SNOTEL gauge within 25 miles, October to mid-December/.test(sig[2].factors[1].why) && sig[2].factors[1].conf === 'weak');
  ok('no factor prints a movement percentage; the only percent is the herd share on an opener', sig.every(s => s.factors.every(f => !/\d+%/.test(f.why) || /of a herd/.test(f.why))));
  ok('Saturday\'s front arrives by day, so the window is last light', sig[2].best.when === 'dusk' && /colder than mid-morning/.test(sig[2].best.why), sig[2].best.why);
  ok('every factor carries a confidence word and a reason', sig.every(s => s.factors.every(f => /^(strong|moderate|weak|contested)$/.test(f.conf) && f.why.length > 20)));
  ok('the cold front calls itself a hunch with no mule deer or elk study', /no mule deer or elk study that measured it, so treat it as a hunch/.test(sig[2].factors.find(f => f.k === 'Cold front').why));
  ok('Sunday: rut shoulder (+1), hard freeze (+1), clearing after the storm (+1): Strong', sig[3].tier === 'Strong' && names(sig[3]) === 'Rut+1 Hard freeze+1 Clearing after the storm+1' && sig[3].factors[0].conf === 'moderate' && /guide's rule of thumb/.test(sig[3].factors[2].why), names(sig[3]));
  ok('Monday: rut (+1) and a 28-degree low (+1) against an 11-degree warm-up (-1): Good', sig[4].tier === 'Good' && names(sig[4]) === 'Rut+1 Hard freeze+1 Warm-up-1', names(sig[4]));
  ok('Wednesday at 72: rut, warm-up and a warm day: Fair, and the warm day says 70 is a guide\'s figure', sig[6].tier === 'Fair' && names(sig[6]) === 'Rut+1 Warm-up-1 Warm day-1' && /guide's figure/.test(sig[6].factors[2].why), names(sig[6]));
  const elk = days.map((d, i) => S.T.fxSignal(days, i, 'elk', NOW));
  ok('for elk: no November rut, no hard freeze (a mule deer study), Saturday Good, Wednesday Slow at 72', elk[2].tier === 'Good' && names(elk[2]) === 'Snow in the forecast~0 Cold front+1 Wind~0' && elk[3].factors.every(f => f.k !== 'Rut') && elk[6].tier === 'Slow' && elk[6].who === 'Elk', names(elk[2]) + ' | ' + names(elk[6]));
  ok('after mid-morning today, the window becomes last light', S.T.fxSignal(days, 0, 'deer', Date.parse('2026-10-29T18:00:00Z')).best.when === 'dusk');
  const dark = S.T.fxSignal(days, 0, 'deer', Date.parse('2026-10-30T04:00:00Z'));
  ok('after dark today, the window is first light tomorrow, from about tomorrow\'s start', dark.best.when === 'next' && dark.best.label === 'First light tomorrow' && dark.best.window === 'from about ' + vm.runInContext('clock', S.box)(days[1].light.start), JSON.stringify(dark.best));

  /* 4. Opening days from seasons.json. */
  ok('the general rifle deer opener counts on the day and the two after, not the fourth', S.T.fxOpeners('2026-10-17', 'deer').some(s => s.id === 'deer-rifle') && S.T.fxOpeners('2026-10-19', 'deer').some(s => s.id === 'deer-rifle') && !S.T.fxOpeners('2026-10-20', 'deer').length, JSON.stringify(S.T.fxOpeners('2026-10-20', 'deer').map(s => s.id)));
  ok('the extended archery hunts never count as an opener', !S.T.fxOpeners('2026-09-12', 'deer').length && !S.T.fxOpeners('2026-08-15', 'elk').some(s => /ext/.test(s.id)));
  ok('only rifle openers count: the muzzleloader and the draw-only youth hunt do not', !S.T.fxOpeners('2026-09-24', 'deer').length && !S.T.fxOpeners('2026-09-13', 'elk').length && S.T.fxOpeners('2026-10-04', 'elk').map(s => s.id).sort().join() === 'elk-early-rifle,elk-spike-rifle', JSON.stringify(S.T.fxOpeners('2026-10-04', 'elk').map(s => s.id)));
  ok('the early rifle deer hunt counts on its twelve units only, matched by base name', S.T.fxOpeners('2026-10-08', 'deer', ['Box Elder, West']).some(s => s.id === 'deer-early-rifle') && !S.T.fxOpeners('2026-10-08', 'deer', ['Cache, East Rich']).length && !S.T.fxOpeners('2026-10-08', 'deer', []).length && !S.T.fxOpeners('2026-10-08', 'deer').length);
  const openerDay = { key: '2026-10-17', hi: 60, lo: 35, pop: 0, snow: 0, wind: 5, gust: null, hours: [], light: null, moon: null, name: 'Saturday' };
  const openerSig = S.T.fxSignal([openerDay], 0, 'deer', NOW);
  ok('an opener scores -1 for deer (moderate) and names the hunt, Wyoming and the roads', openerSig.factors[0].k === 'Opening days' && openerSig.factors[0].dir === -1 && openerSig.factors[0].conf === 'moderate' && /Buck deer - any legal weapon \(rifle\) opened today/.test(openerSig.factors[0].why) && /In Wyoming, bucks moved farther from roads/.test(openerSig.factors[0].why), JSON.stringify(openerSig.factors[0]));
  const elkOpener = S.T.fxSignal([{ ...openerDay, key: '2026-10-04' }], 0, 'elk', NOW);
  const elkOpen = elkOpener.factors.find(f => f.k === 'Opening days');
  ok('an elk opener is strong, quotes 10 to 15% of a herd, and sits beside the rut shoulder', elkOpen && elkOpen.conf === 'strong' && elkOpen.dir === -1 && /10 to 15% of a herd/.test(elkOpen.why) && elkOpener.factors[0].k === 'Rut' && elkOpener.factors[0].conf === 'moderate', JSON.stringify(elkOpener.factors));

  /* 5. The screen. */
  html = S.T.vForecast();
  ok('the hero names the spot, the tier in words and the window as an estimate', /Cache, East Rich/.test(html) && /Fair day for deer/.test(html) && /First light, from about \d[^<]*\(estimate\)\./.test(html), html.slice(0, 600));
  ok('seven day rows, each tapping to its day, coloured by tier', (html.match(/data-fx="day:\d"/g) || []).length === 8 && /data-fx="day:2" style="--g:var\(--brand\)"/.test(html) && /data-fx="day:3" style="--g:var\(--elk\)"/.test(html) && /Saturday Oct 31 &middot; Good/.test(html), html);
  ok('the source line names the Weather Service, the office, the grid cell and when it was issued and fetched', /National Weather Service, SLC office, grid cell near Logan, UT at 5,906 ft, issued .*; fetched/.test(html), html.slice(html.indexOf('Forecast: National')).slice(0, 300));
  ok('legal light is labelled an estimate and points at the guidebook, in the Today card\'s words', /Legal light today &middot; estimate/.test(html) && /guidebook table shifts a few minutes by county and is the legal one/.test(html) && /Computed for the centre of Cache, East Rich/.test(html));
  ok('the moon card says it is not scored', /Moon<\/div>/.test(html) && /not scored/.test(html));
  ok('no percentage sits beside the movement read', !/(Strong|Good|Fair|Slow)[^<]{0,20}\d+%/.test(html) && !/\d+% (High|Moderate|Low)/.test(html));
  ok('the why sheet repeats the table with confidence words and the sources', /First and last light &middot; strong/.test(S.T.fxSheetWhy()) && /Rut &middot; dates strong, daytime effect moderate/.test(S.T.fxSheetWhy()) && /Hard freeze &middot; strong, mule deer/.test(S.T.fxSheetWhy()) && /Barometric pressure &middot; contested/.test(S.T.fxSheetWhy()) && /Rittenhouse/.test(S.T.fxSheetWhy()) && /48 whitetail bucks/.test(S.T.fxSheetWhy()) && /never claims a percentage/.test(S.T.fxSheetWhy()));
  ok('the privacy page says the one time a position leaves the phone, rounded, to the weather service', /rounded to about a kilometre/.test(S.T.vPrivacy()) && /goes to the weather service and nowhere else/.test(S.T.vPrivacy()) && /to no online service but one/.test(S.T.vPrivacy()));
  ok('before any link is filled in the screen carries no paid link', !/Paid link/.test(html));
  vm.runInContext('PL = { links: [{ slot: "forecast", company: "Example Gear Co", label: "Gaiters at Example Gear Co", url: "https://example.com/g" }] }; plState = "ready";', S.box);
  const withLink = S.T.vForecast();
  ok('a forecast paid link is drawn once, last, marked, after the source line and the Why button, below the legal-light card', /Why these factors<\/button><\/p><div class="fx-paid"><p class="fine paidlink"><b>Paid link<\/b> &middot; <a href="https:\/\/example\.com\/g" target="_blank" rel="sponsored noopener">Gaiters at Example Gear Co<\/a>\. Ranger Hawk earns a commission if you join or buy through it\. Tapping lets that site set a cookie so Ranger Hawk is credited\.<\/p><\/div>$/.test(withLink) && withLink.indexOf('Paid link') === withLink.lastIndexOf('Paid link') && withLink.indexOf('Paid link') > withLink.indexOf('Legal light today') && withLink.indexOf('Paid link') > withLink.indexOf('This week'), withLink.slice(-400));
  vm.runInContext('PL = { links: [] };', S.box);
  ok('with no link the wrapper is not drawn either', !/fx-paid/.test(S.T.vForecast()));
  const day2 = S.T.fxSheetDay(2);
  ok('a day sheet: stats, the factors, the light caveat, first and last light hour by hour, the forecaster\'s words', /Saturday, Oct 31/.test(day2) && /Cold front &middot; weak/.test(day2) && /\(estimate\)\.<\/b>/.test(day2) && /shifts a few minutes by county/.test(day2) && /First light, hour by hour/.test(day2) && /Last light<\/div>/.test(day2) && /In the forecaster's words/.test(day2) && /Snow Showers Likely, with a high near 46/.test(day2), day2.slice(0, 400));
  ok('the day sheet shows hourly rows for the dawn window', (day2.match(/<tr>/g) || []).length >= 6, (day2.match(/<tr>/g) || []).length);
  await S.click({ fxsp: 'elk' });
  ok('tapping Elk re-reads the week and saves the choice', S.T.FX.species === 'elk' && JSON.parse(S.store.get('ha.fx')).species === 'elk' && /Strong day for elk|Fair day for elk/.test(S.elements.view.innerHTML));
  await S.click({ fx: 'day:6' });
  ok('tapping a day opens its sheet', /Wednesday, Nov 4/.test(S.opened[S.opened.length - 1]) && /Slow day for elk/.test(S.opened[S.opened.length - 1]));

  /* 5b. The week the clocks go back: local days, hourly rows and grid chunks across November 1. */
  const DAYS2 = DAYS.map((d, i) => ({ ...d, d: shift('2026-10-31', i), snowIn: undefined }));
  const week2 = nwsWeek(DAYS2);
  week2.grid.properties.snowfallAmount.values.push({ validTime: '2026-11-03T06:00:00+00:00/PT6H', value: 3 * 25.4 });   // 23:00 MST Nov 2 to 05:00 Nov 3
  const NOW2 = Date.parse('2026-10-31T13:00:00Z');
  let S2 = await app({ online: true, week: week2, now: NOW2 });
  S2.T.FX.spot = SPOT; S2.T.setTab('forecast'); S2.T.vForecast(); await S2.flush();
  const days2 = S2.T.fxDays(S2.T.fxRecord(key), SPOT, NOW2);
  ok('seven local days across the daylight-saving change, 24 hourly rows each', days2.map(d => d.key).join() === '2026-10-31,2026-11-01,2026-11-02,2026-11-03,2026-11-04,2026-11-05,2026-11-06' && days2.every(d => d.hours.length === 24), days2.map(d => d.key + ':' + d.hours.length).join(' '));
  ok('a grid chunk that starts at 23:00 standard time is dated by its midpoint, the next day', days2[3].snow === 3 && days2[2].snow === 0, JSON.stringify(days2.map(d => d.snow)));
  ok('the light and moon are computed for every day of that week', days2.every(d => d.light && d.moon && (d.moon.rise || d.moon.set)));
  /* SunCalc's getMoonTimes scans the UTC day, which starts at 6 pm in Utah, so an evening rise lands on the next day's label and some local days show none (2026-10-26 at the Cache unit's centre, 10-25 at Salt Lake City). The local-day scan must find them, and agree with SunCalc to the minute on the times it does give. */
  const moonAt = (y, m, d, lat, lon) => vm.runInContext('fxMoonTimes', S2.box)(new S2.box.Date(y, m - 1, d), lat, lon);
  const cache26 = moonAt(2026, 10, 26, 41.804, -111.169), cache25 = moonAt(2026, 10, 25, 41.804, -111.169), slc25 = moonAt(2026, 10, 25, 40.761, -111.891);
  const hm = v => v ? v.toLocaleTimeString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' }) : null;
  ok('moonrise is found on the local days SunCalc leaves empty, and matches its times', cache26.rise && cache25.rise && hm(cache25.rise) === '5:56 PM' && /^6:2[78] PM$/.test(hm(cache26.rise)) && slc25.rise && /^6:0[01] PM$/.test(hm(slc25.rise)), JSON.stringify([hm(cache25.rise), hm(cache26.rise), hm(slc25.rise)]));
  ok('moonset agrees with SunCalc to the minute where SunCalc finds it', hm(cache26.set) === '8:36 AM' && hm(cache25.set) === '7:19 AM', JSON.stringify([hm(cache26.set), hm(cache25.set)]));

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
  let gone = 0;
  S = await app({ online: true, storage: stored, now: NOW + 5 * 3600000, nwsFail: u => u.endsWith('/forecast') && gone++ === 0 ? 404 : false });
  S.T.setTab('forecast');
  S.T.vForecast(); await S.flush();
  html = S.T.vForecast();
  ok('a stored grid URL that answers 404 is looked up again through points, and the week loads', S.fetched.filter(u => u.includes('/points/')).length === 1 && !/Could not refresh/.test(html) && /Fair day for (deer|elk)/.test(html) && !/fetched 5 h/.test(html), html.slice(0, 300));
  S = await app({ online: false, storage: stored, now: NOW + 5 * 3600000, gpsFail: true });
  S.T.setTab('forecast');
  await S.click({ fx: 'gps' });
  ok('a refused GPS fix is said even when a stored week is up', /No GPS fix: denied/.test(S.elements.view.innerHTML) && (S.elements.view.innerHTML.match(/data-fx="day:\d"/g) || []).length === 8);

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
    ok('a unit\'s weather spot sits inside its box and carries its name, for the opener check too', spot.lat >= unit.bb[1] && spot.lat <= unit.bb[3] && spot.lon >= unit.bb[0] && spot.lon <= unit.bb[2] && spot.label === unit.n && spot.kind === 'unit' && spot.units[0] === unit.n, JSON.stringify(spot));
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

  /* 9. Snow on the ground, from a fixture gauge 8 miles north of the spot (41.856 against 41.74). */
  const gauge = (over = {}) => ({ station: '999:UT:SNTL', name: 'Test Gauge', where: 'above the spot', elev_ft: 9100, lat: 41.856, lon: -111.83, depth_in: 12, depth_in_7d_ago: 0, date: '2026-10-28', water_in: 2, water_in_7d_ago: 0, ...over });
  const snowWeek = async st => { const A = await app({ online: true, snow: { _source: 'test', checked: 'test', stations: st } }); A.T.FX.spot = SPOT; A.T.setTab('forecast'); A.T.vForecast(); await A.flush(); return A; };
  let W = await snowWeek([gauge()]);
  let wd = W.T.fxDays(W.T.fxRecord(key), SPOT, NOW), ws = W.T.fxSignal(wd, 0, 'deer', NOW, undefined, SPOT);
  const snowF = ws.factors.find(f => f.k === 'Snow on the ground');
  ok('a gauge 8 miles off at 12 inches scores +1 strong and names the gauge, its elevation and the distance', snowF && snowF.dir === 1 && snowF.conf === 'strong' && snowF.why === 'About 12 inches of snow on the ground at Test Gauge (9,100 ft, 8 miles away): snow this deep is what sends mule deer and elk down from summer range.', JSON.stringify(snowF));
  ok('Thursday becomes Good on the snow alone and the hero leads with it', ws.tier === 'Good' && ws.score === 1 && /About 12 inches of snow on the ground at Test Gauge/.test(W.T.vForecast()), ws.tier + ' ' + ws.score);
  ok('the same for elk', W.T.fxSignal(wd, 0, 'elk', NOW, undefined, SPOT).factors.some(f => f.k === 'Snow on the ground' && f.dir === 1 && f.conf === 'strong'));
  ok('with no spot passed, the screen\'s spot is used', W.T.fxSignal(wd, 0, 'deer', NOW).factors.some(f => f.k === 'Snow on the ground'));
  const sat = W.T.fxSignal(wd, 2, 'deer', NOW, undefined, SPOT);
  ok('Saturday: the gauge sits between the hard freeze and the forecast snow, and the day is Strong', names(sat) === 'Hard freeze+1 Snow on the ground+1 Snow in the forecast~0 Cold front+1 Wind~0' && sat.tier === 'Strong', names(sat));
  ok('the day sheet carries it too', /Snow on the ground &middot; strong/.test(W.T.fxSheetDay(0)));
  ok('the Why sheet states the gauge rule: 25 miles, three days, ten inches, both species', /Snow on the ground &middot; strong<\/dt>/.test(W.T.fxSheetWhy()) && /within 25 miles, read in the last three days, shows ten inches or more/.test(W.T.fxSheetWhy()) && !/not on this screen yet/.test(W.T.fxSheetWhy()));
  const noSnow = async st => { const A = await snowWeek(st); const d = A.T.fxDays(A.T.fxRecord(key), SPOT, NOW); return !A.T.fxSignal(d, 0, 'deer', NOW, undefined, SPOT).factors.some(f => f.k === 'Snow on the ground') && !A.T.fxSignal(d, 2, 'deer', NOW, undefined, SPOT).factors.some(f => f.k === 'Snow on the ground'); };
  ok('the same gauge at 6 inches scores nothing', await noSnow([gauge({ depth_in: 6 })]));
  ok('a gauge 40 miles off scores nothing', await noSnow([gauge({ lat: 42.32 })]));
  ok('a reading five days old scores nothing', await noSnow([gauge({ date: '2026-10-24' })]));
  ok('a gauge with no coordinates scores nothing', await noSnow([gauge({ lat: undefined, lon: undefined })]));
  ok('no gauge file at all scores nothing', await noSnow([]));
  W = await snowWeek([gauge({ lat: 41.9, depth_in: 20 }), gauge({ name: 'Near Gauge', depth_in: 11, elev_ft: 8200 })]);
  wd = W.T.fxDays(W.T.fxRecord(key), SPOT, NOW);
  ok('with two deep gauges in range the nearer one is named', /at Near Gauge \(8,200 ft, 8 miles away\)/.test(W.T.fxSignal(wd, 0, 'deer', NOW, undefined, SPOT).factors.find(f => f.k === 'Snow on the ground').why));
  W = await snowWeek([gauge({ name: 'Low Gauge', lat: 41.82, elev_ft: 7000, depth_in: 0 }), gauge({ name: 'High Gauge', lat: 41.93, elev_ft: 9900, depth_in: 14 })]);   // 6 miles with no snow, 13 miles with snow
  wd = W.T.fxDays(W.T.fxRecord(key), SPOT, NOW);
  ok('a nearer, lower gauge with no snow does not hide the deep one farther off: the valley spot is told the snow is up there', /About 14 inches of snow on the ground at High Gauge \(9,900 ft, 13 miles away\)/.test((W.T.fxSignal(wd, 0, 'deer', NOW, undefined, SPOT).factors.find(f => f.k === 'Snow on the ground') || {}).why || ''), JSON.stringify(W.T.fxSignal(wd, 0, 'deer', NOW, undefined, SPOT).factors));
  W = await snowWeek([gauge({ lat: 41.7545 })]);   // one mile north
  wd = W.T.fxDays(W.T.fxRecord(key), SPOT, NOW);
  ok('one mile is "1 mile away"', /\(9,100 ft, 1 mile away\)/.test(W.T.fxSignal(wd, 0, 'deer', NOW, undefined, SPOT).factors.find(f => f.k === 'Snow on the ground').why));
  W = await snowWeek([gauge({ lat: 41.745 })]);    // a third of a mile
  wd = W.T.fxDays(W.T.fxRecord(key), SPOT, NOW);
  ok('closer than half a mile is "under a mile away"', /\(9,100 ft, under a mile away\)/.test(W.T.fxSignal(wd, 0, 'deer', NOW, undefined, SPOT).factors.find(f => f.k === 'Snow on the ground').why));
  const july = { key: '2026-07-15', hi: 80, lo: 45, pop: 0, snow: 0, wind: 5, gust: null, hours: [], light: null, moon: null, name: 'Wednesday' };
  W = await snowWeek([gauge({ depth_in: 30, date: '2026-07-14' })]);
  ok('deep snow in July is left-over snowpack, not a push: nothing outside October to mid-December', !W.T.fxSignal([july], 0, 'deer', Date.parse('2026-07-15T13:00:00Z'), undefined, SPOT).factors.some(f => f.k === 'Snow on the ground'));
  ok('the shipped snow.json gauges all carry lat, lon and an elevation', (() => { const j = JSON.parse(fs.readFileSync(path.join(DOCS, 'data', 'ut', 'snow.json'), 'utf8')); return j.stations.length >= 1 && j.stations.every(g => isFinite(g.lat) && isFinite(g.lon) && g.elev_ft > 0); })());

  /* 10. The deep link from a static unit page: ?fx=<slug>. */
  S = await app({ online: false });
  const loadingUnits = S.T.unitsLoad(); await S.flush(); await loadingUnits; await S.flush();
  const slugs = S.T.state().HU.slugs, cacheSlug = slugs['Cache, East Rich'], cacheUnit = (S.T.state().UNITS || []).find(u => u.n === 'Cache, East Rich');
  ok('the Cache, East Rich unit has a slug', !!cacheSlug && !!cacheUnit, cacheSlug);
  let D = await app({ online: false, search: '?fx=' + cacheSlug });
  ok('?fx= opens the forecast tab with the unit as the spot once the shapes load, and opens no sheet', D.T.state().tab === 'forecast' && D.T.FX.spot && D.T.FX.spot.kind === 'unit' && D.T.FX.spot.id === cacheUnit.id && D.T.FX.spot.label === 'Cache, East Rich' && D.opened.length === 0, JSON.stringify([D.T.state().tab, D.T.FX.spot, D.opened.length]));
  ok('it loaded the unit shapes to do it', D.fetched.some(u => /units_geo\.json/.test(u)));
  D = await app({ online: false, search: '?fx=no-such-unit' });
  ok('an unknown slug opens the tab on the last spot', D.T.state().tab === 'forecast' && D.T.FX.spot === null && D.T.fxSpot().kind === 'town' && D.opened.length === 0, JSON.stringify([D.T.state().tab, D.T.FX.spot]));
  D = await app({ online: false, search: '?unit=' + cacheSlug + '&fx=' + cacheSlug });
  ok('?unit= with ?fx=: the tab wins and the sheet is not opened', D.T.state().tab === 'forecast' && D.T.FX.spot && D.T.FX.spot.id === cacheUnit.id && D.opened.length === 0, JSON.stringify([D.T.state().tab, D.opened.length]));
  D = await app({ online: false, search: '?unit=' + cacheSlug });
  ok('?unit= alone still opens the sheet, not the tab', D.T.state().tab !== 'forecast' && D.opened.length === 1 && /Cache, East Rich/.test(D.opened[0]), JSON.stringify([D.T.state().tab, D.opened.length]));
  D = await app({ online: false, search: '?fx=' + cacheSlug, static: true });
  ok('a static renderer never reads it: no parameter, no tab, no unit load', D.T.fxUnitParam() === null && D.T.state().tab !== 'forecast' && D.T.FX.spot === null && !D.fetched.some(u => /units_geo\.json/.test(u)), JSON.stringify([D.T.fxUnitParam(), D.T.state().tab, D.T.FX.spot]));
  D = await app({ online: false });
  const loadingD = D.T.unitsLoad(); await D.flush(); await loadingD; await D.flush();
  D.box.location.search = '?fx=' + cacheSlug;
  D.T.fxResetParam();
  D.T.setStatic(true);
  ok('with the shapes loaded, static mode still opens nothing', D.T.fxOpenLink() === false && D.T.fxUnitParam() === null && D.T.state().tab !== 'forecast' && D.T.FX.spot === null);
  D.T.setStatic(false);
  ok('off static, the same parameter opens the screen on the unit', D.T.fxOpenLink() === true && D.T.state().tab === 'forecast' && D.T.FX.spot && D.T.FX.spot.id === cacheUnit.id);
  ok('the static sheet renderer links the static unit page to the deep link in the button\'s own words', (() => { D.T.setStatic(true); const h = D.T.sheetUnit(cacheUnit.id); D.T.setStatic(false); return h.includes('<a class="btn ghost" href="/?fx=' + cacheSlug + '">7-day hunt forecast for this unit</a>') && !h.includes('data-fx='); })());

  /* 11. The events: by name alone, once per app open, through the counter's switch. */
  const E = await app({ online: true });
  E.T.FX.spot = SPOT; E.T.setTab('forecast'); E.T.vForecast(); await E.flush();
  await E.click({ fxsp: 'elk' }); await E.click({ fxsp: 'elk' }); await E.click({ fxsp: 'deer' }); await E.click({ fx: 'why' }); await E.click({ fx: 'why' });
  const ev = E.pixels.filter(u => /[?&]e=true/.test(u)).map(u => new URL(u));
  ok('a species tap sends exactly one forecast-species-elk pixel per app open; deer and why likewise', ev.map(u => u.searchParams.get('p')).sort().join() === '/event/forecast-species-deer,/event/forecast-species-elk,/event/forecast-why', E.pixels.join(' '));
  ok('each event goes to the site code with e=true and nothing but p, e and rnd', ev.length === 3 && ev.every(u => u.origin === 'https://rangerhawk.goatcounter.com' && u.pathname === '/count' && [...u.searchParams.keys()].sort().join() === 'e,p,rnd'), ev.map(u => u.href).join(' '));
  ok('no coordinates, spot or unit name in any pixel', E.pixels.length > 0 && E.pixels.every(u => !/41\.7|111\.8|Cache|East|spot|lat|lon/i.test(decodeURIComponent(u))), E.pixels.join(' '));
  const E2 = await app({ online: false });
  E2.T.FX.spot = SPOT; E2.T.setTab('forecast');
  await E2.click({ fxsp: 'elk' }); await E2.click({ fx: 'why' });
  ok('offline: no event pixel', E2.pixels.length === 0, E2.pixels.join(' '));
  const E3 = await app({ online: true, counter: '' });
  E3.T.FX.spot = SPOT; E3.T.setTab('forecast'); E3.T.vForecast(); await E3.flush();
  await E3.click({ fxsp: 'elk' }); await E3.click({ fx: 'why' });
  ok('COUNTER_CODE empty: no pixel at all', E3.pixels.length === 0, E3.pixels.join(' '));

  /* 12. The four things the 2026-11-03 weather sanity pass found (research/2026-11-03_forecast-money_weather-sanity.md). */
  const hourRow = (week, d, h) => week.hourly.properties.periods.find(p => p.startTime === local(d, h));
  const setHours = (week, d, hs, patch) => hs.forEach(h => Object.assign(hourRow(week, d, h), patch));
  const periodOf = (week, d, isDay) => week.forecast.properties.periods.find(p => p.startTime === local(d, isDay ? 6 : 18));
  const chance = v => ({ probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: v } });
  const load = async (week, now = NOW, spot = SPOT, extra = {}) => {
    const A = await app({ online: true, week, now, ...extra });
    A.T.FX.spot = spot; A.T.setTab('forecast'); A.T.vForecast(); await A.flush();
    const r = A.T.fxRecord(A.T.fxKey(spot));
    return { A, rec: r, days: A.T.fxDays(r, spot, now), html: A.T.vForecast() };
  };
  const rowText = (h, i) => (new RegExp('data-fx="day:' + i + '" style[\\s\\S]*?<span class="s">([^<]*)</span>').exec(h) || [])[1];
  const tile = (h, k) => (new RegExp('<div class="k">' + k + '</div><div class="v">(.*?)</div>').exec(h) || [])[1];
  const pair = d => d.dir + ' ' + d.wind;

  /* 12a. Wind: the peak of the hours inside legal light, with that hour's own direction. */
  const windList = DAYS.map(d => ({ ...d }));
  windList[1] = { ...windList[1], w: '7 mph', dir: 'WNW' };
  const wk1 = nwsWeek(windList);
  setHours(wk1, '2026-10-30', [0, 1], { windSpeed: '12 mph', windDirection: 'E' });        // the Zion case: a midnight wind from another quarter
  setHours(wk1, '2026-10-29', [20, 21, 22], { windSpeed: '15 mph', windDirection: 'E' });  // the Kamas case: tonight's wind on today's row
  setHours(wk1, '2026-11-01', [14], { windSpeed: '9 mph', windDirection: 'NW' });          // the peak hour blows from somewhere the period does not name
  setHours(wk1, '2026-11-02', [6, 7], { windDirection: 'E' });                             // a tie: the first hours of light from the east, the rest from the period's south
  setHours(wk1, '2026-11-03', [6, 7, 8, 9, 10, 11], { windDirection: 'SE' });              // a tie with no hour from the period's direction
  setHours(wk1, '2026-11-03', [12, 13, 14, 15, 16, 17], { windDirection: 'SW' });
  let X = await load(wk1);
  ok('a midnight wind from another quarter is not the day\'s wind: the row shows the daylight peak and its direction', pair(X.days[1]) === 'WNW 7' && /^Mostly Sunny &middot; WNW 7 mph/.test(rowText(X.html, 1)), pair(X.days[1]) + ' | ' + rowText(X.html, 1));
  ok('tonight\'s wind does not sit on today\'s row or tile', pair(X.days[0]) === 'S 5' && tile(X.A.T.fxSheetDay(0), 'Wind') === 'S 5 mph', pair(X.days[0]) + ' | ' + tile(X.A.T.fxSheetDay(0), 'Wind'));
  ok('the direction is the peak hour\'s own, not the daytime period\'s', pair(X.days[3]) === 'NW 9' && X.days[3].dayP.d === 'N' && tile(X.A.T.fxSheetDay(3), 'Wind') === 'NW 9 mph', pair(X.days[3]));
  ok('where hours tie for the peak, one from the daytime period\'s direction is taken', pair(X.days[4]) === 'S 5' && X.days[4].hours.find(h => /T06:/.test(h.s)).d === 'E', pair(X.days[4]));
  ok('a tie between two directions equally far from the period\'s takes the earliest', pair(X.days[5]) === 'SE 10' && X.days[5].dayP.d === 'S', pair(X.days[5]));
  /* The Kamas unit on 2026-11-14: 8 mph from the SE at dawn and from the WNW in the afternoon, beside a period that says NW. */
  const tieList = DAYS.map(d => ({ ...d }));
  tieList[2] = { ...tieList[2], w: '8 mph', dir: 'NW' };
  const wkTie = nwsWeek(tieList);
  setHours(wkTie, '2026-10-31', [...Array(24).keys()], { windSpeed: '4 mph', windDirection: 'S' });
  setHours(wkTie, '2026-10-31', [7, 8], { windSpeed: '8 mph', windDirection: 'SE' });
  setHours(wkTie, '2026-10-31', [14, 15, 16], { windSpeed: '8 mph', windDirection: 'WNW' });
  const tie = await load(wkTie);
  ok('a tie with no hour from the period\'s exact direction takes the nearest on the compass, not the earliest', pair(tie.days[2]) === 'WNW 8' && tie.days[2].dayP.d === 'NW', pair(tie.days[2]));
  ok('compass distance wraps through north and an unknown direction never wins a tie', vm.runInContext("fxTurn('NNW', 'NNE') === 2 && fxTurn('N', 'S') === 8 && fxTurn('W', 'W') === 0 && fxTurn('', 'NW') === 99 && fxTurn('VRB', 'NW') === 99", tie.A.box));
  ok('the wind factor still says shown, not scored, and scores nothing', (() => { const sat = X.A.T.fxSignal(X.days, 2, 'deer', NOW).factors.find(v => v.k === 'Wind'); return !!sat && sat.dir === 0 && sat.conf === 'contested' && /^Wind to 33 mph: /.test(sat.why) && /Shown, not scored\.$/.test(sat.why) && /Shown from 18 mph, not scored\./.test(X.A.T.fxSheetWhy()); })());
  const wk2 = nwsWeek();
  wk2.hourly.properties.periods = wk2.hourly.properties.periods.filter(p => !p.startTime.startsWith('2026-11-03') && !(p.startTime.startsWith('2026-11-04') && +p.startTime.slice(11, 13) >= 12));
  setHours(wk2, '2026-11-04', [9], { windSpeed: '20 mph', windDirection: 'E' });
  X = await load(wk2);
  ok('a day with no hourly rows takes the daytime period\'s own wind and direction', X.days[5].hours.length === 0 && pair(X.days[5]) === 'S 10', pair(X.days[5]));
  ok('hourly rows that stop before legal light ends are not trusted for a peak: the period\'s own wind stands', X.days[6].hours.length === 12 && pair(X.days[6]) === 'S 5', pair(X.days[6]));
  const NIGHT = Date.parse('2026-10-30T02:00:00Z');   // 8:00 pm MDT, Thursday
  const wk3 = nwsWeek();
  wk3.forecast.properties.periods.shift();            // after 6 pm the weather service drops today's daytime period
  Object.assign(wk3.forecast.properties.periods[0], { name: 'Tonight', windSpeed: '5 to 10 mph', windDirection: 'E' }, chance(30));
  wk3.hourly.properties.periods = wk3.hourly.properties.periods.filter(p => Date.parse(p.startTime) >= NIGHT);
  setHours(wk3, '2026-10-29', [20, 21, 22, 23], { windSpeed: '15 mph', windDirection: 'NE' });
  X = await load(wk3, NIGHT);
  ok('after dark today, with no daylight hours and no daytime period, the night period\'s wind and direction are taken together', X.days[0].key === '2026-10-29' && !X.days[0].dayP && pair(X.days[0]) === 'E 10', pair(X.days[0]));
  ok('after dark the one chance left is tonight\'s and says so, on the tile and in the row', X.days[0].dpop === null && X.days[0].npop === 30 && tile(X.A.T.fxSheetDay(0), 'Precip') === '30% night' && / &middot; precip 30% tonight$/.test(rowText(X.html, 0)), JSON.stringify([X.days[0].dpop, X.days[0].npop, tile(X.A.T.fxSheetDay(0), 'Precip'), rowText(X.html, 0)]));

  /* 12b. Precipitation: the day and the night apart, as the weather service files them. */
  const wk4 = nwsWeek();
  periodOf(wk4, '2026-10-29', true).name = 'Today';
  Object.assign(periodOf(wk4, '2026-10-29', false), { name: 'Tonight' }, chance(24));                       // the Kamas case: a dry day, 24% tonight
  setHours(wk4, '2026-10-29', [20, 21, 22, 23], chance(24));
  Object.assign(periodOf(wk4, '2026-10-30', false), chance(40));                                            // Friday: 10% by day, 40% at night
  Object.assign(periodOf(wk4, '2026-10-31', false), chance(90));                                            // Saturday: 70% by day, 90% at night
  Object.assign(periodOf(wk4, '2026-11-01', false), chance(40));                                            // Sunday night into Monday before dawn
  setHours(wk4, '2026-11-02', [2, 3, 4], chance(40));
  Object.assign(periodOf(wk4, '2026-11-03', true), chance(null)); Object.assign(periodOf(wk4, '2026-11-03', false), chance(null));   // the weather service sends null for no chance
  wk4.forecast.properties.periods.pop();                                                                     // the seventh night period is not out yet
  setHours(wk4, '2026-11-04', [18, 19, 20, 21, 22, 23], chance(35));
  X = await load(wk4);
  const pd = X.days, sheetTile = i => tile(X.A.T.fxSheetDay(i), 'Precip');
  ok('a dry day with a chance tonight: the tile shows the two apart and the row says tonight', pd[0].dpop === 0 && pd[0].npop === 24 && tile(X.html, 'Precip') === '0% day<br>24% night' && rowText(X.html, 0) === 'Sunny &middot; S 5 mph &middot; precip 24% tonight', JSON.stringify([pd[0].dpop, pd[0].npop, tile(X.html, 'Precip'), rowText(X.html, 0)]));
  ok('no bare percentage stands for tonight\'s chance on the Today tile or row', !/<div class="k">Precip<\/div><div class="v">24%<\/div>/.test(X.html) && !/precip 24%(?! tonight)/.test(X.html));
  ok('another day whose only chance is at night says at night', pd[1].dpop === 10 && pd[1].npop === 40 && / &middot; precip 40% at night$/.test(rowText(X.html, 1)) && sheetTile(1) === '10% day<br>40% night', rowText(X.html, 1) + ' | ' + sheetTile(1));
  ok('a day with both shows the day\'s chance bare and the night\'s labelled', / &middot; precip 70%, 90% at night$/.test(rowText(X.html, 2)) && sheetTile(2) === '70% day<br>90% night', rowText(X.html, 2) + ' | ' + sheetTile(2));
  ok('a chance before dawn belongs to the night before, as the weather service files it, and is not on the next day\'s row', / &middot; precip 40% at night$/.test(rowText(X.html, 3)) && pd[4].dpop === 0 && pd[4].npop === 0 && !/precip/.test(rowText(X.html, 4)) && sheetTile(4) === '0%', rowText(X.html, 3) + ' | ' + rowText(X.html, 4) + ' | ' + sheetTile(4));
  ok('the factors still read the largest figure on the calendar day, as before', pd[0].pop === 24 && pd[4].pop === 40 && pd[2].pop === 90);
  ok('a null chance from the weather service is 0, and a day and night that agree show one figure', pd[5].dpop === 0 && pd[5].npop === 0 && sheetTile(5) === '0%' && !/precip/.test(rowText(X.html, 5)));
  ok('with the night period not out yet, the evening hours stand in and are labelled', pd[6].npop === 35 && pd[6].nlabel === 'at night' && / &middot; precip 35% at night$/.test(rowText(X.html, 6)) && sheetTile(6) === '0% day<br>35% night', rowText(X.html, 6) + ' | ' + sheetTile(6));
  const plain = await load(nwsWeek());
  ok('the storm day in the standing week, 70% by day and by night, reads precip 70% once and one figure on its tile', rowText(plain.html, 2) === 'Snow Showers Likely &middot; NW 25 mph &middot; precip 70%' && tile(plain.A.T.fxSheetDay(2), 'Precip') === '70%' && tile(plain.html, 'Precip') === '0%', rowText(plain.html, 2) + ' | ' + tile(plain.A.T.fxSheetDay(2), 'Precip'));
  const DAWN = Date.parse('2026-10-29T09:00:00Z');    // 3:00 am MDT, Thursday
  const wk5 = nwsWeek();
  wk5.forecast.properties.periods.unshift({ ...nwsPeriod(DAYS[0], false), name: 'Overnight', startTime: local('2026-10-29', 3), endTime: local('2026-10-29', 6), ...chance(30) });
  periodOf(wk5, '2026-10-29', false).name = 'Thursday Night';
  wk5.hourly.properties.periods = wk5.hourly.properties.periods.filter(p => Date.parse(p.startTime) >= DAWN);
  wk5.forecast.properties.periods[0].probabilityOfPrecipitation.value = 60;
  X = await load(wk5, DAWN);
  ok('at 3 am a wet Overnight with a dry night to come is not shown as a chance at night', X.days[0].dpop === 0 && X.days[0].npop === 0 && !/precip/.test(rowText(X.html, 0)) && tile(X.html, 'Precip') === '0%', JSON.stringify([X.days[0].dpop, X.days[0].npop, rowText(X.html, 0), tile(X.html, 'Precip')]));
  Object.assign(periodOf(wk5, '2026-10-29', false), chance(30));
  X = await load(wk5, DAWN);
  ok('at 3 am the coming night\'s chance is the one shown, and it is "at night" because the weather service does not yet call it Tonight', X.days[0].npop === 30 && X.days[0].nlabel === 'at night' && / &middot; precip 30% at night$/.test(rowText(X.html, 0)) && tile(X.html, 'Precip') === '0% day<br>30% night', rowText(X.html, 0) + ' | ' + tile(X.html, 'Precip'));
  /* A stored week opened offline the next day: Friday is now Today, and its night period is not named Tonight. */
  X = await load(wk4);
  const TOMORROW = NOW + 86400000, stale = X.A.T.fxDays(X.rec, SPOT, TOMORROW);
  ok('a stored week read a day later: the first row is the new day, its wind is that day\'s daylight peak and its night chance is not called tonight', stale.length === 6 && stale[0].key === '2026-10-30' && stale[0].name === 'Today' && pair(stale[0]) === 'SW 10' && stale[0].npop === 40 && stale[0].nlabel === 'at night', JSON.stringify([stale.length, stale[0].key, pair(stale[0]), stale[0].npop, stale[0].nlabel]));
  /* A fetch at 1 pm: the daytime period is This Afternoon and the hourly rows start now. */
  const NOON = Date.parse('2026-10-29T19:00:00Z');   // 1:00 pm MDT, Thursday
  const wk6 = nwsWeek();
  Object.assign(wk6.forecast.properties.periods[0], { name: 'This Afternoon', startTime: local('2026-10-29', 13) });
  wk6.forecast.properties.periods[1].name = 'Tonight';
  wk6.hourly.properties.periods = wk6.hourly.properties.periods.filter(p => Date.parse(p.startTime) >= NOON);
  setHours(wk6, '2026-10-29', [15], { windSpeed: '9 mph', windDirection: 'NW' });
  setHours(wk6, '2026-10-29', [20, 21, 22], { windSpeed: '15 mph', windDirection: 'E' });
  X = await load(wk6, NOON);
  ok('fetched at 1 pm: today\'s wind is the peak of the daylight hours still to come, with its own direction', X.days[0].hours.length === 11 && pair(X.days[0]) === 'NW 9', X.days[0].hours.length + ' ' + pair(X.days[0]));
  /* No sun times (SunCalc not on the phone yet): no daylight hours to pick from, so the period's own wind stands. */
  X = await load(wk1);
  vm.runInContext('__keepSun = SUN; SUN = null;', X.A.box);
  const noSun = X.A.T.fxDays(X.rec, SPOT, NOW);
  vm.runInContext('SUN = __keepSun;', X.A.box);
  ok('with no sun times the daytime period\'s own wind and direction are shown, never the midnight hour', noSun[1].light === null && pair(noSun[1]) === 'WNW 7' && pair(noSun[3]) === 'N 5', pair(noSun[1]) + ' | ' + pair(noSun[3]));

  /* 12c. The hard-freeze line: the forecast low in its own sentence, the study's range in the next. */
  const freeze = sig[4].factors.find(f => f.k === 'Hard freeze');
  ok('Monday\'s 28-degree low: the forecast low stands apart from the study\'s range, same claim, same confidence', freeze && freeze.dir === 1 && freeze.conf === 'strong' && freeze.why === 'Forecast low of 28°. A hard freeze, with night lows from about 32° down to 23°, is what typically starts mule deer drifting off the high country (Wyoming and Montana GPS does).', JSON.stringify(freeze));
  ok('no factor runs a forecast low into the study\'s range any more', sig.every(s => s.factors.every(f => !/near 32 to 23|Low of \d+°:/.test(f.why))));
  X = await load(nwsWeek());
  const cold = (key, lo, sp = 'deer') => X.A.T.fxSignal([{ key, hi: 40, lo, pop: 0, snow: 0, wind: 5, gust: null, hours: [], light: null, moon: null, name: 'Tuesday' }], 0, sp, NOW, [], SPOT).factors.find(f => f.k === 'Hard freeze');
  ok('the rule the Why sheet now states is the rule the code runs: 28 or colder, October 1 to December 15, deer only', !!cold('2026-12-15', 28) && !cold('2026-12-15', 29) && !cold('2026-12-16', 20) && !cold('2026-09-30', 20) && !!cold('2026-10-01', 28) && !cold('2026-11-10', 10, 'elk'));
  ok('a low far below the study\'s range still reads true, at zero and below it too', [10, 0, -5].every(lo => cold('2026-11-10', lo).why.startsWith('Forecast low of ' + lo + '°. A hard freeze, with night lows from about 32° down to 23°, is what typically starts')));
  ok('the Why sheet gives the range the same way and states the trigger', /<dt>Hard freeze &middot; strong, mule deer<\/dt><dd>Night lows from about 32 down to 23 degrees are what typically start mule deer drifting off the high country \(Wyoming and Montana GPS does\)\. Scored \+1 for deer when the forecast low is 28 degrees or colder, October to mid-December\. Not scored for elk, where the studies point to snow depth and hunting pressure instead\.<\/dd>/.test(X.A.T.fxSheetWhy()));

  /* 12d. The rounded spot and its grid cell: nothing more precise is sent, and the line says whose forecast it is. */
  const cellLine = /; fetched [^.<]*\. The forecast is for that grid cell at that elevation, not the exact spot, and may differ from it\. Sun and moon computed on this phone for 41\.740, -111\.830\./;
  ok('the source line says the forecast is for the named cell at its elevation, on the screen and on a day sheet', cellLine.test(X.html) && cellLine.test(X.A.T.fxSheetDay(2)) && /grid cell near Logan, UT at 5,906 ft, issued/.test(X.html), X.html.slice(X.html.indexOf('Forecast: National')).slice(0, 400));
  ok('the sentence is said once on the screen', X.html.split('not the exact spot').length === 2);
  const noGrid = await load(nwsWeek(), NOW, SPOT, { nwsFail: u => /gridpoints\/SLC\/1,1$/.test(u) });
  ok('with no elevation on the record the sentence does not point at one', noGrid.rec.elev === null && /SLC office, grid cell near Logan, UT, issued [^.<]*; fetched [^.<]*\. The forecast is for that grid cell, not the exact spot, and may differ from it\. Sun/.test(noGrid.html), noGrid.html.slice(noGrid.html.indexOf('Forecast: National')).slice(0, 400));
  const wkNoNear = nwsWeek(); delete wkNoNear.points.properties.relativeLocation;
  const noNear = await load(wkNoNear);
  ok('with no place name for the cell the sentence does not say "that" cell', /SLC office, at 5,906 ft, issued [^.<]*; fetched [^.<]*\. The forecast is for a grid cell at that elevation, not the exact spot, and may differ from it\. Sun/.test(noNear.html), noNear.html.slice(noNear.html.indexOf('Forecast: National')).slice(0, 400));
  const bare = await load(wkNoNear, NOW, SPOT, { nwsFail: u => /gridpoints\/SLC\/1,1$/.test(u) });
  ok('with neither, it is still a true sentence', /SLC office, issued [^.<]*; fetched [^.<]*\. The forecast is for a grid cell, not the exact spot, and may differ from it\. Sun/.test(bare.html), bare.html.slice(bare.html.indexOf('Forecast: National')).slice(0, 400));
  const Z = await load(nwsWeek(), NOW, { lat: 37.2645, lon: -112.9932, label: 'Zion', kind: 'unit', id: 2, units: ['Zion'] });
  ok('a unit centre with four decimals still goes to the weather service at two, and nothing finer leaves the phone', Z.A.fetched.filter(u => u.includes('weather.gov'))[0] === 'https://api.weather.gov/points/37.26,-112.99' && [...Z.A.fetched, ...Z.A.pixels].every(u => !/37\.26\d|112\.99\d/.test(decodeURIComponent(u))) && /Sun and moon computed on this phone for 37\.26[45], -112\.993\./.test(Z.html), Z.A.fetched.filter(u => u.includes('weather.gov')).join(' '));

  finished = true;
  console.log(`test_forecast: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  ERROR ' + (e && e.stack || e)); process.exit(1); });
