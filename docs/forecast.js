/* Ranger Hawk - hunt forecast: seven days of weather, light, moon and an
   honest read on mule deer and elk movement, for one spot.

   The big apps sell a "deer movement" score with a percentage from a black box. This screen shows
   the same week in the National Weather Service's own words and then says
   WHICH things in it matter for mule deer and elk, in which direction, and how
   sure the research is. No percentage, because nobody can honestly give one.

   The spot is where the hunter is standing, a hunt unit, an access point, or
   the home town. Weather: api.weather.gov (US government work, no key). Sun
   and moon: computed on the phone with SunCalc. The last forecast for each
   spot stays in localStorage so the week is still there with no signal, marked
   with when it was fetched. Nothing about the hunter leaves the phone except
   the coordinates the weather service needs to pick its grid cell.

   Loaded after units.js; shares app.js globals ($, esc, clock, SUN, UNITS, DB,
   tab, render, openSheet, closeSheet, legalLight, anchorById, anchorId,
   unitsAt, hUnit, unitLink). */
'use strict';

const FX = { spot: null, species: 'deer', cache: {}, loading: null, error: null };
try {
  const saved = JSON.parse(localStorage.getItem('ha.fx') || '{}');
  if (saved && saved.spot && isFinite(saved.spot.lat) && isFinite(saved.spot.lon)) FX.spot = saved.spot;
  if (saved && (saved.species === 'deer' || saved.species === 'elk')) FX.species = saved.species;
} catch (e) { /* private mode or bad JSON */ }
const fxSave = () => { try { localStorage.setItem('ha.fx', JSON.stringify({ spot: FX.spot, species: FX.species })); } catch (e) { /* private mode */ } };

const FX_TTL = 90 * 60000;          // refresh a forecast older than this when there is signal
const FX_KEEP = 3;                  // spots kept on the phone
const FX_TZ = 'America/Denver';     // all of Utah
const FX_TIER = { Strong: 'var(--elk)', Good: 'var(--brand)', Fair: 'var(--faint)', Slow: 'var(--warn)' };
const fxKey = s => s.lat.toFixed(2) + ',' + s.lon.toFixed(2);
const fxDF = new Intl.DateTimeFormat('en-CA', { timeZone: FX_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fxHF = new Intl.DateTimeFormat('en-US', { timeZone: FX_TZ, hour: 'numeric', hourCycle: 'h23' });
const fxWF = new Intl.DateTimeFormat('en-US', { timeZone: FX_TZ, weekday: 'long' });
const fxLF = new Intl.DateTimeFormat('en-US', { timeZone: FX_TZ, weekday: 'short', month: 'short', day: 'numeric' });
const fxDay = iso => fxDF.format(new Date(iso));
const fxHour = iso => parseInt(fxHF.format(new Date(iso)), 10);
const fxMph = s => { const m = /(\d+)(?:\s*to\s*(\d+))?\s*mph/.exec(String(s || '')); return m ? +(m[2] || m[1]) : null; };
const fxNow = () => (typeof units !== 'undefined' && units.now != null) ? units.now : Date.now();

/* ------------------------------------------------------------------ spot ---- */
function fxSpot() {
  if (FX.spot && isFinite(FX.spot.lat) && isFinite(FX.spot.lon)) return FX.spot;
  const a = typeof anchorById === 'function' && typeof anchorId === 'function' ? anchorById(anchorId()) : null;
  return a ? { lat: a.lat, lon: a.lon, label: a.label, kind: 'town' } : { lat: 40.7608, lon: -111.8911, label: 'Salt Lake City', kind: 'town' };
}
/* The centre of a hunt unit for weather: the area centre of its largest outer
   ring, which can sit outside a crescent-shaped unit and is still the right
   grid cell for the week ahead. The sheet says it is the centre, not a spot. */
function fxUnitSpot(u) {
  let best = null, bestArea = 0;
  for (const poly of u.p || []) {
    const ring = poly && poly[0];
    if (!ring || ring.length < 3) continue;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
    }
    if (a && Math.abs(a) > bestArea) { bestArea = Math.abs(a); best = { lon: cx / (3 * a), lat: cy / (3 * a) }; }
  }
  if (!best) best = { lon: (u.bb[0] + u.bb[2]) / 2, lat: (u.bb[1] + u.bb[3]) / 2 };
  return { lat: +best.lat.toFixed(4), lon: +best.lon.toFixed(4), label: u.n, kind: 'unit', id: u.id, units: [u.n] };
}
function fxSetSpot(spot) {
  FX.spot = spot; FX.error = null; fxSave();
  if (typeof closeSheet === 'function') closeSheet();
  tab = 'forecast'; render();
  try { window.scrollTo(0, 0); } catch (e) { /* no window */ }
}
function fxLocate() {
  if (!navigator.geolocation) { FX.error = { key: 'gps', msg: 'This phone is not sharing location with the app.' }; render(); return; }
  FX.loading = { key: 'gps' }; render();
  navigator.geolocation.getCurrentPosition(pos => {
    const lat = +pos.coords.latitude.toFixed(4), lon = +pos.coords.longitude.toFixed(4);
    const here = typeof unitsAt === 'function' && UNITS ? unitsAt(lon, lat) : [];
    FX.loading = null;
    fxSetSpot({ lat, lon, label: here.length ? 'Where I am: ' + here[0].n : 'Where I am', kind: 'gps', units: here.map(u => u.n) });
  }, err => { FX.loading = null; FX.error = { key: 'gps', msg: 'No GPS fix: ' + (err.message || 'location was refused') + '.' }; render(); },
  { enableHighAccuracy: false, timeout: 20000, maximumAge: 120000 });
}

/* --------------------------------------------------------------- storage ---- */
function fxStored(key) { try { return JSON.parse(localStorage.getItem('ha.fx.' + key) || 'null'); } catch (e) { return null; } }
function fxStore(key, rec) {
  try {
    localStorage.setItem('ha.fx.' + key, JSON.stringify(rec));
    const keys = JSON.parse(localStorage.getItem('ha.fx.keys') || '[]').filter(k => k !== key);
    keys.unshift(key);
    keys.splice(FX_KEEP).forEach(k => localStorage.removeItem('ha.fx.' + k));
    localStorage.setItem('ha.fx.keys', JSON.stringify(keys));
  } catch (e) { /* private mode or full */ }
}
function fxRecord(key) {
  if (!FX.cache[key]) { const s = fxStored(key); if (s && s.periods) FX.cache[key] = s; }
  return FX.cache[key] || null;
}

/* ----------------------------------------------------------------- fetch ---- */
/* The weather service answers a 500 now and then; one retry covers it. The
   grid URLs for a spot never change, so they are kept with the record. */
async function fxJson(url, tries = 2) {
  for (let i = 1; ; i++) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 15000) : null;
    try {
      const r = await fetch(url, { headers: { Accept: 'application/geo+json' }, signal: ctl ? ctl.signal : undefined });
      if (!r.ok) { const e = new Error('weather service answered ' + r.status); e.status = r.status; throw e; }
      return await r.json();
    } catch (e) { if (i >= tries || (e.status >= 400 && e.status < 500)) throw e; }   // a 4xx will not change on a retry
    finally { if (timer) clearTimeout(timer); }
  }
}
/* Grid layers come as (UTC validTime, SI value) chunks; keep what the day rows sum. */
function fxGrid(g, name, scale) {
  const layer = g && g.properties && g.properties[name];
  const span = iso => { const m = /P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso || ''); return m ? ((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600000 + (+m[3] || 0) * 60000 : 0; };
  // A chunk is dated by its midpoint: a six-hour chunk starting at 23:00 belongs to the next day, which matters once the clocks go back.
  return (layer && layer.values || []).filter(v => v.value != null).map(v => { const [start, dur] = v.validTime.split('/'); return { s: new Date(Date.parse(start) + span(dur) / 2).toISOString(), v: +(v.value * scale).toFixed(2) }; });
}
async function fxLoad(spot, force) {
  const key = fxKey(spot), have = fxRecord(key);
  if (have && !force && fxNow() - have.at < FX_TTL) return have;
  if (!navigator.onLine) return have;
  if (FX.loading && FX.loading.key === key && FX.loading.p) return FX.loading.p;
  const p = (async () => {
    let urls = have && have.urls && have.urls.f && have.urls.h ? have.urls : null;
    const reused = !!urls;
    const points = async () => {
      const P = (await fxJson(`https://api.weather.gov/points/${spot.lat.toFixed(2)},${spot.lon.toFixed(2)}`)).properties;
      const near = P.relativeLocation && P.relativeLocation.properties;
      urls = { f: P.forecast, h: P.forecastHourly, g: P.forecastGridData, office: P.gridId, near: near ? near.city + ', ' + near.state : '' };
    };
    const week = () => Promise.all([fxJson(urls.f), fxJson(urls.h), urls.g ? fxJson(urls.g).catch(() => null) : null]);
    if (!urls) await points();
    let f, h, g;
    try { [f, h, g] = await week(); }
    catch (e) { if (!reused || e.status !== 404) throw e; await points(); [f, h, g] = await week(); }   // the stored grid URLs went stale
    const pop = p => p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value != null ? p.probabilityOfPrecipitation.value : null;
    const rec = {
      at: fxNow(), urls, issued: f.properties.updateTime || f.properties.generatedAt || null,
      elev: g && g.properties.elevation && g.properties.elevation.value != null ? Math.round(g.properties.elevation.value * 3.28084) : null,
      periods: f.properties.periods.map(p => ({ s: p.startTime, e: p.endTime, day: !!p.isDaytime, n: p.name, t: p.temperature, w: p.windSpeed, d: p.windDirection, sf: p.shortForecast, df: p.detailedForecast, pop: pop(p) })),
      hourly: h.properties.periods.slice(0, 170).map(p => ({ s: p.startTime, t: p.temperature, w: p.windSpeed, d: p.windDirection, sf: p.shortForecast, pop: pop(p) })),
      gust: fxGrid(g, 'windGust', 0.621371), snow: fxGrid(g, 'snowfallAmount', 1 / 25.4), qpf: fxGrid(g, 'quantitativePrecipitation', 1 / 25.4)
    };
    FX.cache[key] = rec; FX.error = null; fxStore(key, rec);
    return rec;
  })();
  FX.loading = { key, p };
  p.then(() => { if (FX.loading && FX.loading.p === p) FX.loading = null; },
    e => { if (FX.loading && FX.loading.p === p) FX.loading = null; FX.error = { key, msg: String(e && e.message || e) }; });
  return p;
}

/* ------------------------------------------------------------ sun and moon -- */
const FX_PHASES = [[0.03, 'New'], [0.22, 'Waxing crescent'], [0.28, 'First quarter'], [0.47, 'Waxing gibbous'], [0.53, 'Full'], [0.72, 'Waning gibbous'], [0.78, 'Last quarter'], [0.97, 'Waning crescent'], [2, 'New']];
/* Moonrise and moonset by scanning the moon's altitude across the local day
   (midnight to the next midnight, so a 23- or 25-hour day is covered) every
   ten minutes and bisecting each crossing. SunCalc's own getMoonTimes misses a
   rise on some days because it scans the UTC day, which starts at 6 pm here
   (Cache on 2026-10-26, Salt Lake City on the 25th), and the sheet would print
   a dash for a moon that plainly rises that evening. The
   horizon is SunCalc's own moonHeight: the apparent altitude it reports (in
   degrees, refraction and parallax included) plus the moon's semidiameter and
   its 0.09-degree allowance, crossing zero. */
function fxMoonTimes(day, lat, lon) {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  const up = t => { const p = SUN.getMoonPosition(new Date(t), lat, lon); return p.altitude + 0.2725 * Math.asin(6371 / p.distance) * 180 / Math.PI + 0.09; };
  let rise = null, set = null, prev = up(start), anyUp = prev > 0, anyDown = prev <= 0;
  for (let t = start + 600000; t <= end; t += 600000) {
    const cur = up(t);
    if ((prev <= 0) !== (cur <= 0)) {
      let lo = t - 600000, hi = t;
      for (let k = 0; k < 10; k++) { const mid = (lo + hi) / 2; if ((up(mid) <= 0) === (prev <= 0)) lo = mid; else hi = mid; }
      const at = new Date(Math.round((lo + hi) / 2 / 60000) * 60000);
      if (cur > 0) { if (!rise) rise = at; } else if (!set) set = at;
    }
    if (cur > 0) anyUp = true; else anyDown = true;
    prev = cur;
  }
  return { rise, set, alwaysUp: !rise && !set && anyUp && !anyDown, alwaysDown: !rise && !set && anyDown && !anyUp };
}
function fxMoon(day, lat, lon) {
  if (!SUN || !SUN.getMoonPosition || !SUN.getMoonIllumination) return null;
  const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12);
  const ill = SUN.getMoonIllumination(noon), t = fxMoonTimes(day, lat, lon);
  return { name: FX_PHASES.find(([lim]) => ill.phase < lim)[1], frac: Math.round(ill.fraction * 100), rise: t.rise, set: t.set, up: t.alwaysUp, down: t.alwaysDown };
}

/* ------------------------------------------------------------------ days ---- */
/* Seven local days from today. The 12-hour periods carry the forecaster's
   words and the high and low; the hourly rows feed the dawn and dusk tables
   and the best-window call; the grid layers add gusts and snow. */
function fxDays(rec, spot, now) {
  const start = fxDay(new Date(now == null ? fxNow() : now).toISOString());
  const [y, m, d] = start.split('-').map(Number);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const key = fxDay(new Date(Date.UTC(y, m - 1, d + i, 19)).toISOString());
    const [ky, km, kd] = key.split('-').map(Number), date = new Date(ky, km - 1, kd);
    const dayP = rec.periods.find(p => p.day && fxDay(p.s) === key) || null;
    const nightP = rec.periods.find(p => !p.day && fxDay(p.s) === key) || null;
    const hours = rec.hourly.filter(h => fxDay(h.s) === key);
    if (!dayP && !nightP && !hours.length) continue;
    const temps = hours.map(h => h.t).filter(t => t != null);
    const sum = list => +(list.filter(v => fxDay(v.s) === key).reduce((a, v) => a + v.v, 0)).toFixed(2);
    const gust = Math.max(0, ...(rec.gust || []).filter(v => fxDay(v.s) === key).map(v => v.v));
    out.push({
      key, date, i, name: i === 0 ? 'Today' : fxWF.format(date), label: fxLF.format(date),
      hi: dayP ? dayP.t : (temps.length ? Math.max(...temps) : null),
      lo: nightP ? nightP.t : (temps.length ? Math.min(...temps) : null),
      words: dayP ? dayP.sf : (nightP ? nightP.sf : (hours[0] ? hours[0].sf : '')),
      nwords: nightP ? nightP.sf : '',
      wind: Math.max(0, fxMph(dayP && dayP.w) || 0, ...hours.map(h => fxMph(h.w) || 0)) || null,
      dir: dayP ? dayP.d : (hours[0] ? hours[0].d : ''),
      gust: gust ? Math.round(gust) : null,
      pop: Math.max(0, dayP && dayP.pop || 0, nightP && nightP.pop || 0, ...hours.map(h => h.pop || 0)),
      snow: sum(rec.snow || []), rain: sum(rec.qpf || []),
      hours, dayP, nightP,
      light: typeof legalLight === 'function' ? legalLight(date, spot.lat, spot.lon) : null,
      moon: fxMoon(date, spot.lat, spot.lon)
    });
  }
  return out;
}

/* ---------------------------------------------------------------- signal ---- */
/* Each factor: a direction (-2 to +2), a confidence word, and the reason a
   hunter would accept. The tier is the sum, in words. Moon is shown and not
   scored. The table behind this is research/2026-10-26_forecast-movement-
   evidence.md; the sheet "Why these factors" repeats it on the phone. */
/* Rut windows from the Utah DWR mule deer and elk management plans. The dates
   are strong; the daytime-movement effect near the peak is moderate (no Utah
   GPS study measures it). Mule deer peak mid-November; elk peak mid to late
   September, early September to early October around it. */
const FX_RUT = {
  deer: [['11-08', '11-22', 2, 'Mule deer rut, the Utah peak: near it, bucks tend and chase does by day and move more at midday than usual. Typical for the herd; no Utah GPS study measures the daytime change.'],
    ['11-01', '11-07', 1, 'Mule deer rut building: bucks start seeking out doe groups and move more by day. Typical for the herd, not a promise.'],
    ['11-23', '11-30', 1, 'Mule deer rut tailing off: some bucks still seeking does; after the rut they go quiet again.']],
  elk: [['09-12', '09-30', 2, 'Elk rut, the Utah peak: bulls bugle, gather cows and move by day. Typical for the herd; no Utah GPS study measures the daytime change.'],
    ['09-01', '09-11', 1, 'Early elk rut: bulls start gathering cows and move more by day. Typical for the herd, not a promise.'],
    ['10-01', '10-07', 1, 'Elk rut tailing off: bulls still with the cows, then they go quiet again.']]
};
/* Rifle seasons that opened in the last three days for this species, from
   seasons.json. The evidence is about rifle openers; the archery, muzzleloader
   and draw-only hunts bring far fewer hunters and are left out, as are the
   extended archery hunts that run for months. A season limited to named units
   counts only when the spot is in one of them; a spot with no unit (a town, a
   tapped point) never counts those. */
function fxOpeners(key, sp, units) {
  const S = typeof DB !== 'undefined' && DB && DB.seasons && DB.seasons.seasons || [];
  const names = units || [];
  const inUnit = list => names.some(n => list.some(u => n === u || n.startsWith(u + ',')));
  return S.filter(s => s.group === sp && /rifle/.test(s.id || '') && !/ext/.test(s.id || '') && s.start
    && key >= s.start && key <= fxDay(new Date(Date.parse(s.start + 'T19:00:00Z') + 2 * 86400000).toISOString())
    && (!s.units || inUnit(s.units)) && !(s.except && inUnit(s.except)));
}
/* Each factor: a direction (-2 to +2), a confidence word, and the reason a
   hunter would accept, worded from research/2026-10-26_forecast-movement-
   evidence.md and no stronger than it. The tier is the sum, in words. Wind,
   the moon and snow in the forecast are shown and not scored. */
function fxSignal(days, i, species, now, units) {
  const d = days[i], prev = days[i - 1] || null, prev2 = days[i - 2] || null, F = [];
  const sp = species === 'elk' ? 'elk' : 'deer', who = sp === 'elk' ? 'Elk' : 'Deer';
  const push = (k, dir, conf, why) => F.push({ k, dir, conf, why });
  const mmdd = d.key.slice(5), migration = mmdd >= '10-01' && mmdd <= '12-15';
  const here = units || (FX.spot && FX.spot.units) || [];
  for (const [a, b, w, why] of FX_RUT[sp]) if (mmdd >= a && mmdd <= b) { push('Rut', w, 'moderate', why); break; }
  const opened = fxOpeners(d.key, sp, here);
  if (opened.length) {
    const s = opened[0], when = s.start === d.key ? 'today' : fxLF.format(new Date(s.start + 'T12:00:00-07:00'));
    push('Opening days', -1, sp === 'elk' ? 'strong' : 'moderate', sp === 'elk'
      ? `${s.name} opened ${when}. When the rifle hunt opens, many elk move onto private land or into thick cover away from roads; Utah counted 10 to 15% of a herd shifting in the first days. Hunt away from the roads.`
      : `${s.name} opened ${when}. In Wyoming, bucks moved farther from roads once the rifle season opened. Hunt away from the roads.`);
  }
  if (sp === 'deer' && migration && d.lo != null && d.lo <= 28) push('Hard freeze', 1, 'strong', `Low of ${d.lo}°: a hard freeze, night lows near 32 to 23°, is what typically starts mule deer drifting off the high country (Wyoming and Montana GPS does).`);
  if (d.snow >= 1) push('Snow in the forecast', 0, 'weak', `About ${d.snow < 2 ? d.snow.toFixed(1) : Math.round(d.snow)}" forecast: fresh tracks, and a heavy, windy storm keeps animals bedded until it eases. What sends mule deer and elk downhill is snow piled up on the ground, about ten inches, which this screen cannot see yet. Shown, not scored.`);
  if (prev && d.hi != null && prev.hi != null) {
    const drop = prev.hi - d.hi;
    if (drop >= 10) push('Cold front', 1, 'weak', `The high falls ${drop}° from ${prev.name}. Hunters report more daylight movement after a cold snap; we found no mule deer or elk study that measured it, so treat it as a hunch.`);
    else if (d.hi - prev.hi >= 8) push('Warm-up', -1, 'weak', `${d.hi - prev.hi}° warmer than ${prev.name}. Hunters report animals bedding earlier on a warm-up; we found no mule deer or elk study that measured it.`);
  }
  if (prev && prev2 && prev.hi != null && prev2.hi != null && d.hi != null && prev2.hi - prev.hi >= 10 && d.pop < 30 && d.hi - prev.hi <= 5)
    push('Clearing after the storm', 1, 'weak', "The first calm, cold day after a storm: an elk guide's rule of thumb that animals get up to feed after sitting it out. We found no study.");
  if (d.hi != null && d.hi >= 80) push('Heat', -2, 'moderate', `High of ${d.hi}°: on hot days animals bed in shade through the middle of the day; expect movement at first and last light only. No mule deer or elk study gives a temperature; 70° is a guide's figure.`);
  else if (d.hi != null && d.hi >= 70) push('Warm day', -1, 'moderate', `High of ${d.hi}°: animals bed in shade through the middle of the day; first and last light. No mule deer or elk study gives a temperature; 70° is a guide's figure.`);
  if (d.snow < 1 && d.pop >= 70 && /rain|showers|thunder|snow/i.test(d.words)) push('Steady precipitation', -1, 'weak', "Heavy weather keeps animals bedded until it eases; light rain or snow changes little. An elk guide's rule of thumb; we found no study.");
  const w = Math.max(d.wind || 0, d.gust || 0);
  if (w >= 18) push('Wind', 0, 'contested', `Wind to ${w} mph: studies on deer disagree about wind and movement, so it is shown for your stalk and scent, not as a reason ${sp} will or will not move. Shown, not scored.`);
  if (d.moon && d.moon.name === 'Full') push('Full moon', 0, 'weak', "A bright night. Hunters report slower mornings; a GPS study of 48 whitetail bucks found no effect of the moon's phase or position, and there is no mule deer or elk moon study. Shown, not scored.");
  const score = F.reduce((s, f) => s + f.dir, 0);
  const tier = score >= 3 ? 'Strong' : score >= 1 ? 'Good' : score >= -1 ? 'Fair' : 'Slow';
  let when = 'dawn', why = `First light: ${sp} feed and travel at the edges of the day and rest through the middle, and the morning is the colder, stiller one.`;
  const at = h => (d.hours || []).find(x => fxHour(x.s) === h), am = at(8), pm = at(16);
  if (am && pm) {
    if (pm.t != null && am.t != null && pm.t <= am.t - 6) { when = 'dusk'; why = `The front arrives during the day: by ${clock(new Date(pm.s))} it is ${am.t - pm.t}° colder than mid-morning.`; }
    else if ((am.pop || 0) >= 60 && (pm.pop || 0) < 30) { when = 'dusk'; why = 'The morning precipitation clears by afternoon; animals get up to feed as it does.'; }
    else if ((fxMph(am.w) || 0) >= 18 && (fxMph(pm.w) || 0) < 10) { when = 'dusk'; why = 'The wind lies down in the afternoon: a quieter stalk, and better hearing both ways.'; }
  }
  const L = d.light, t = now == null ? fxNow() : now, next = days[i + 1];
  let label = when === 'dawn' ? 'First light' : 'Last light', window = L ? (when === 'dawn' ? 'from about ' + clock(L.start) : 'until about ' + clock(L.late)) : '';
  if (i === 0 && L && t > L.late.getTime()) { when = 'next'; label = 'First light tomorrow'; window = next && next.light ? 'from about ' + clock(next.light.start) : ''; why = 'Today is done. The next move is the first hour of light.'; }
  else if (i === 0 && L && t > L.sunrise.getTime() + 2 * 3600000) { when = 'dusk'; label = 'Last light'; window = 'until about ' + clock(L.late); why = 'First light has passed. Last light is the next move.'; }
  return { tier, score, factors: F, best: { when, label, window, why }, who };
}

/* ---------------------------------------------------------------- screen ---- */
const fxDeg = t => t == null ? '--' : t + '&deg;';
const fxT = v => v ? clock(v) : '--';
function fxStats(d) {
  return `<div class="stats fxs">
    <div class="stat"><div class="k">High</div><div class="v">${fxDeg(d.hi)}</div></div>
    <div class="stat"><div class="k">Low</div><div class="v">${fxDeg(d.lo)}</div></div>
    <div class="stat"><div class="k">Wind</div><div class="v">${d.wind != null ? esc(d.dir || '') + ' ' + d.wind + ' mph' : '--'}</div></div>
    <div class="stat"><div class="k">Gusts</div><div class="v">${d.gust ? d.gust + ' mph' : '--'}</div></div>
    <div class="stat"><div class="k">Precip</div><div class="v">${d.pop}%</div></div>
    <div class="stat"><div class="k">Snow</div><div class="v">${d.snow >= 0.1 ? d.snow.toFixed(1) + ' in' : '--'}</div></div>
  </div>`;
}
function fxLightStats(d) {
  const L = d.light;
  if (!L) return '';
  return `<div class="stats">
    <div class="stat"><div class="k">Start (all)</div><div class="v">${clock(L.start)}</div></div>
    <div class="stat"><div class="k">Sunrise</div><div class="v">${clock(L.sunrise)}</div></div>
    <div class="stat"><div class="k">Sunset</div><div class="v">${clock(L.sunset)}</div></div>
    <div class="stat"><div class="k">Upland, big game</div><div class="v">${clock(L.late)}</div></div>
  </div>`;
}
function fxMoonStats(d) {
  const M = d.moon;
  if (!M) return '';
  return `<div class="stats">
    <div class="stat"><div class="k">Moon</div><div class="v" style="font-size:12px">${esc(M.name)} ${M.frac}%</div></div>
    <div class="stat"><div class="k">Moonrise</div><div class="v">${M.up ? 'up all day' : fxT(M.rise)}</div></div>
    <div class="stat"><div class="k">Moonset</div><div class="v">${M.down ? 'down all day' : fxT(M.set)}</div></div>
  </div>`;
}
const fxLightNote = spot => `<p class="fine">Start is 30 minutes before sunrise; waterfowl ends at sunset, upland, turkey and big game 30 minutes after; on WMAs, state land beside the Great Salt Lake and federal refuges everything ends at sunset. Computed for ${spot.kind === 'unit' ? 'the centre of ' + esc(spot.label) : esc(spot.label)} and rounded to the safe side; an estimate. The guidebook table shifts a few minutes by county and is the legal one.</p>`;
function fxFactors(sig) {
  if (!sig.factors.length) return `<p class="fine" style="padding:8px 16px 0">Nothing in this day's forecast pushes ${sig.who.toLowerCase()} either way: an ordinary day, first and last light.</p>`;
  const mark = f => f.dir > 0 ? '+' : f.dir < 0 ? '&minus;' : '~';
  return `<dl class="f">${sig.factors.map(f => `<dt>${mark(f)} ${esc(f.k)} &middot; ${esc(f.conf)}</dt><dd>${esc(f.why)}</dd>`).join('')}</dl>`;
}
function fxRow(d, sig) {
  const bits = [d.words, d.wind != null ? `${d.dir || ''} ${d.wind} mph`.trim() : '', d.pop >= 20 ? `precip ${d.pop}%` : ''].filter(Boolean);
  return `<button class="row" data-fx="day:${d.i}" style="--g:${FX_TIER[sig.tier]}"><span class="pill"></span>
    <span><span class="t">${esc(d.name)}${d.i === 0 ? '' : ' ' + esc(d.label.replace(/^\w+,?\s+/, ''))} &middot; ${esc(sig.tier)}</span><span class="s">${bits.map(esc).join(' &middot; ')}</span></span>
    <span class="v">${fxDeg(d.hi)}<small>${fxDeg(d.lo)}</small></span></button>`;
}
function fxSourceLine(rec, spot) {
  const U = rec.urls || {};
  const where = [U.near ? 'grid cell near ' + esc(U.near) : '', rec.elev != null ? 'at ' + Number(rec.elev).toLocaleString('en-US') + ' ft' : ''].filter(Boolean).join(' ');
  const when = v => { const t = new Date(v); return (fxDay(t.toISOString()) === fxDay(new Date(fxNow()).toISOString()) ? '' : fxLF.format(t) + ' ') + clock(t); };
  return `Forecast: National Weather Service${U.office ? ', ' + esc(U.office) + ' office' : ''}${where ? ', ' + where : ''}${rec.issued ? ', issued ' + when(rec.issued) : ''}; fetched ${when(rec.at)}. Sun and moon computed on this phone for ${spot.lat.toFixed(3)}, ${spot.lon.toFixed(3)}.`;
}
function vForecast() {
  const spot = fxSpot(), key = fxKey(spot), rec = fxRecord(key), now = fxNow();
  const busy = FX.loading && (FX.loading.key === key || FX.loading.key === 'gps');
  if ((!rec || now - rec.at > FX_TTL) && navigator.onLine && !busy && !(FX.error && FX.error.key === key))
    fxLoad(spot).then(() => { if (tab === 'forecast') render(); }, () => { if (tab === 'forecast') render(); });
  let h = `<div class="acts" style="padding:12px 0 0">
    <button class="btn ghost" data-fx="gps">Where I am</button>
    <button class="btn ghost" data-fx="town">Home: ${esc(((typeof anchorById === 'function' && typeof anchorId === 'function' && anchorById(anchorId())) || { label: 'Salt Lake City' }).label)}</button>
    <button class="btn ghost" data-gofind="1">A hunt unit</button></div>
    <div class="drawctl" style="margin:12px 0 0"><span class="note">Reading the week for</span><div class="seg small" role="group" aria-label="Species">
      <button data-fxsp="deer" aria-pressed="${FX.species === 'deer'}">Mule deer</button><button data-fxsp="elk" aria-pressed="${FX.species === 'elk'}">Elk</button></div></div>`;
  if (!rec) {
    const msg = busy ? (FX.loading.key === 'gps' ? 'Getting a GPS fix.' : 'Fetching the week from the National Weather Service.')
      : FX.error && (FX.error.key === key || FX.error.key === 'gps') ? esc(FX.error.msg) + (FX.error.key === key ? ' <button class="btn ghost" data-fx="refresh" style="padding:4px 10px;font-size:12px">Try again</button>' : '')
      : !navigator.onLine ? 'No signal, and no forecast for this spot saved on the phone yet. Open this once with signal; after that the last week fetched stays here.'
      : 'Fetching the week.';
    return h + `<div class="sec-title">${esc(spot.label)}</div><div class="card"><p class="empty">${msg}</p></div>`;
  }
  const days = fxDays(rec, spot, now), sigs = days.map((d, i) => fxSignal(days, i, FX.species, now));
  const t = days[0], s = sigs[0];
  if (!t) return h + `<div class="card"><p class="empty">The saved forecast has run out. ${navigator.onLine ? 'Fetching a new one.' : 'It refreshes when the phone finds signal.'}</p></div>`;
  const old = now - rec.at > FX_TTL;
  h += `<div class="hero"><div class="lab">${esc(spot.label)} &middot; ${esc(t.label)}${old ? ' &middot; fetched ' + esc(fxAgo(now - rec.at)) : ''}</div>
    <div class="big">${esc(s.tier)} day for ${esc(s.who.toLowerCase())}</div>
    <div class="sub">${esc(s.best.label)}${s.best.window ? ', ' + esc(s.best.window) + ' (estimate)' : ''}. ${esc((s.factors.find(f => f.dir) || {}).why || s.best.why)}</div></div>`;
  if (FX.error && FX.error.key === 'gps') h += `<div class="warnbox">${esc(FX.error.msg)}</div>`;
  if (!navigator.onLine) h += `<div class="warnbox">No signal: this is the forecast fetched ${esc(fxAgo(now - rec.at))} ago. Sun and moon are current.</div>`;
  else if (FX.error && FX.error.key === key) h += `<div class="warnbox">Could not refresh: ${esc(FX.error.msg)}. Showing the forecast fetched ${esc(fxAgo(now - rec.at))} ago. <button class="btn ghost" data-fx="refresh" style="padding:4px 10px;font-size:12px">Try again</button></div>`;
  h += `<div class="sec-title">Today</div><div class="card">${fxStats(t)}${fxFactors(s)}<div class="acts" style="padding:10px 14px 12px"><button class="btn ghost" data-fx="day:0">Hour by hour, first and last light</button></div></div>`;
  h += `<div class="sec-title">Legal light today &middot; estimate</div><div class="card">${fxLightStats(t)}${fxLightNote(spot)}</div>`;
  if (t.moon) h += `<div class="sec-title">Moon</div><div class="card">${fxMoonStats(t)}<p class="fine">Phase and times for this spot. Shown because hunters ask; the studies that tracked deer found little change in movement with the moon, so it is not scored.</p></div>`;
  h += `<div class="sec-title">This week</div><div class="card">${days.map((d, i) => fxRow(d, sigs[i])).join('')}</div>`;
  h += `<p class="fine" style="padding:14px 0 0">${fxSourceLine(rec, spot)} The movement read is Ranger Hawk's own, from published research on mule deer and elk: a reason to get up, not a promise. <button class="btn ghost" data-fx="why" style="padding:4px 10px;font-size:12px;margin-top:8px">Why these factors</button></p>`;
  return h;
}
function fxAgo(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? m + ' min' : m < 36 * 60 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' days';
}
function fxHours(d, from, to) {
  const rows = (d.hours || []).filter(h => { const t = new Date(h.s).getTime(); return t >= from && t <= to; });
  if (!rows.length) return `<p class="fine" style="padding:6px 16px 0">${to < fxNow() ? 'This window has passed.' : 'The hourly forecast does not reach this window yet.'}</p>`;
  return `<table class="flim">${rows.map(h => `<tr><td class="mono">${clock(new Date(h.s))}</td><td>${esc(h.sf)}</td><td>${fxDeg(h.t)} &middot; ${esc(h.d || '')} ${esc(h.w || '')}${h.pop ? ' &middot; ' + h.pop + '%' : ''}</td></tr>`).join('')}</table>`;
}
function fxSheetDay(i) {
  const spot = fxSpot(), rec = fxRecord(fxKey(spot));
  if (!rec) return '';
  const days = fxDays(rec, spot), d = days[i];
  if (!d) return '';
  const s = fxSignal(days, i, FX.species), L = d.light, H = 3600000;
  let h = `<h3>${esc(d.i === 0 ? 'Today, ' + d.label : fxWF.format(d.date) + ', ' + d.label.replace(/^\w+,?\s+/, ''))}</h3>
    <p class="where">${esc(s.tier)} day for ${esc(s.who.toLowerCase())} &middot; ${esc(spot.label)}</p>${fxStats(d)}
    <div class="sec-title" style="padding:0 16px">Best window</div><p class="fine" style="padding:4px 16px 0"><b>${esc(s.best.label)}${s.best.window ? ', ' + esc(s.best.window) + ' (estimate)' : ''}.</b> ${esc(s.best.why)}</p>
    <div class="sec-title" style="padding:0 16px">What moves ${esc(s.who.toLowerCase())} this day</div>${fxFactors(s)}`;
  if (L) h += `<div class="sec-title" style="padding:0 16px">Legal light &middot; estimate</div>${fxLightStats(d)}${fxLightNote(spot)}
    <div class="sec-title" style="padding:0 16px">First light, hour by hour</div>${fxHours(d, L.start.getTime() - H, L.sunrise.getTime() + 3 * H)}
    <div class="sec-title" style="padding:0 16px">Last light</div>${fxHours(d, L.sunset.getTime() - 3 * H, L.late.getTime() + H)}`;
  if (d.moon) h += `<div class="sec-title" style="padding:0 16px">Moon</div>${fxMoonStats(d)}`;
  if (d.dayP || d.nightP) h += `<div class="sec-title" style="padding:0 16px">In the forecaster's words</div>
    ${d.dayP ? `<p class="fine" style="padding:4px 16px 0"><b>${esc(d.dayP.n)}.</b> ${esc(d.dayP.df)}</p>` : ''}${d.nightP ? `<p class="fine" style="padding:4px 16px 0"><b>${esc(d.nightP.n)}.</b> ${esc(d.nightP.df)}</p>` : ''}`;
  h += `<p class="fine" style="padding:12px 16px 0">${fxSourceLine(rec, spot)}</p>`;
  return h;
}
function fxSheetWhy() {
  return `<h3>Why these factors</h3><p class="where">What the research says moves mule deer and elk, and how sure it is.</p>
    <dl class="f">
      <dt>First and last light &middot; strong</dt><dd>Elk and mule deer feed and travel at the edges of the day and rest through the middle (Oregon GPS); whitetail work puts the peaks within about two hours of sunrise and sunset. That is the frame for every day here. No study gives it in minutes, so neither does this.</dd>
      <dt>Rut &middot; dates strong, daytime effect moderate</dt><dd>The Utah DWR management plans put the mule deer rut peak in mid-November and the elk rut peak in mid to late September. Near the peak, bucks tend and chase does and bulls gather cows, and both move more by day; after the rut they go quiet. No Utah GPS study measures the daytime change. Scored +2 at the peak, +1 on the shoulders.</dd>
      <dt>Opening days &middot; strong for elk, moderate for deer</dt><dd>When the rifle hunt opens, many elk move onto private land or into thick cover away from roads; Utah counted 10 to 15% of a herd shifting. In Wyoming, mule deer bucks moved farther from roads once the rifle season opened. Scored &minus;1 on a rifle opener and the two days after, for the seasons in this app that cover the spot's unit.</dd>
      <dt>Hard freeze &middot; strong, mule deer</dt><dd>Night lows near 32 to 23 degrees are what typically start mule deer drifting off the high country (Wyoming and Montana GPS does). Scored +1 for deer from October. Not scored for elk, where the studies point to snow depth and hunting pressure instead.</dd>
      <dt>Snow on the ground &middot; strong, not on this screen yet</dt><dd>Snow piling up on the summer range, about ten inches, is the main push that sends mule deer and elk down to winter range. This screen sees forecast snowfall, which the Wyoming study did not support as a predictor on its own, so snow in the forecast is shown and not scored until the gauge readings are wired in.</dd>
      <dt>Heat &middot; moderate</dt><dd>On hot days animals bed in shade through the middle of the day, so expect movement at first and last light. No mule deer or elk study gives a temperature; 70 degrees is a guide's figure. Scored &minus;1, and &minus;2 from 80.</dd>
      <dt>Cold front, and clearing after a storm &middot; weak</dt><dd>Hunters report more daylight movement after a cold snap and on the first calm day after a storm. We found no mule deer or elk study that measured either; a whitetail GPS study found no general pattern. Scored +1 each, as a hunch.</dd>
      <dt>Steady precipitation &middot; weak</dt><dd>Heavy weather keeps animals bedded until it eases; light rain or snow changes little. An elk guide's rule of thumb; no study. Scored &minus;1.</dd>
      <dt>Wind &middot; contested</dt><dd>Studies on deer disagree about wind and movement (all whitetail), so wind is shown for your stalk and scent, not as a reason animals will or will not move. Shown from 18 mph, not scored.</dd>
      <dt>Moon &middot; weak</dt><dd>Hunters report slower mornings after a bright night. A GPS study of 48 whitetail bucks found no effect of the moon's phase or position; there is no mule deer or elk moon study. Shown, not scored.</dd>
      <dt>Barometric pressure &middot; contested</dt><dd>Pressure travels with fronts, wind and temperature, and the studies that tested it alone found no steady effect. Not scored, not shown.</dd>
    </dl>
    <p class="fine" style="padding:12px 16px 0">The rut and the migration overlap in November: when both apply they are listed apart, not blended. Plan statements are herd-wide and typical; individual herds vary. Sources: the Utah DWR mule deer and elk management plans; the Utah and BYU GPS elk work on opening day (Sergeyev and others, 2022); Rodgers and others, 2021, on Wyoming mule deer and roads; Rittenhouse and others, 2015, and Anton and others, 2022, on snow depth and hard freezes; Mississippi State Extension, 2025, on the moon; whitetail GPS weather studies, named as whitetail. Mule deer and elk are not whitetails: most movement-forecast research, and most of the apps, are built on whitetail data. This read says "weak" or "contested" where the Western evidence is thin, and it never claims a percentage. The research notes behind this screen carry the links.</p>`;
}

/* --------------------------------------------------------------- events ---- */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-fx],[data-fxsp]');
  if (!t) return;
  if (t.dataset.fxsp) { FX.species = t.dataset.fxsp === 'elk' ? 'elk' : 'deer'; fxSave(); render(); return; }
  const v = t.dataset.fx || '';
  if (v === 'open') { tab = 'forecast'; render(); try { window.scrollTo(0, 0); } catch (x) { /* no window */ } return; }
  if (v === 'gps') { fxLocate(); return; }
  if (v === 'town') { fxSetSpot(null); return; }
  if (v === 'refresh') { FX.error = null; fxLoad(fxSpot(), true).then(render, render); render(); return; }
  if (v === 'why') { openSheet(fxSheetWhy()); return; }
  if (v.startsWith('day:')) { const html = fxSheetDay(+v.slice(4)); if (html) openSheet(html); return; }
  if (v.startsWith('unit:')) { const u = typeof hUnit === 'function' ? hUnit(v.slice(5)) : null; if (u) fxSetSpot(fxUnitSpot(u)); return; }
  if (v.startsWith('at:')) {
    const [lat, lon] = v.slice(3).split(',').map(Number);
    if (isFinite(lat) && isFinite(lon)) fxSetSpot({ lat: +lat.toFixed(4), lon: +lon.toFixed(4), label: t.dataset.fxlabel || 'This spot', kind: 'point' });
  }
});
