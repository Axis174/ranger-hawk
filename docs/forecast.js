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
  return { lat: +best.lat.toFixed(4), lon: +best.lon.toFixed(4), label: u.n, kind: 'unit', id: u.id };
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
    fxSetSpot({ lat, lon, label: here.length ? 'Where I am: ' + here[0].n : 'Where I am', kind: 'gps' });
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
    try {
      const r = await fetch(url, { headers: { Accept: 'application/geo+json' } });
      if (!r.ok) throw new Error('weather service answered ' + r.status);
      return await r.json();
    } catch (e) { if (i >= tries) throw e; }
  }
}
/* Grid layers come as (UTC validTime, SI value) chunks; keep what the day rows sum. */
function fxGrid(g, name, scale) {
  const layer = g && g.properties && g.properties[name];
  return (layer && layer.values || []).filter(v => v.value != null).map(v => ({ s: v.validTime.split('/')[0], v: +(v.value * scale).toFixed(2) }));
}
async function fxLoad(spot, force) {
  const key = fxKey(spot), have = fxRecord(key);
  if (have && !force && fxNow() - have.at < FX_TTL) return have;
  if (!navigator.onLine) return have;
  if (FX.loading && FX.loading.key === key && FX.loading.p) return FX.loading.p;
  const p = (async () => {
    let urls = have && have.urls;
    if (!urls || !urls.f || !urls.h) {
      const P = (await fxJson(`https://api.weather.gov/points/${spot.lat.toFixed(2)},${spot.lon.toFixed(2)}`)).properties;
      const near = P.relativeLocation && P.relativeLocation.properties;
      urls = { f: P.forecast, h: P.forecastHourly, g: P.forecastGridData, office: P.gridId, near: near ? near.city + ', ' + near.state : '' };
    }
    const [f, h, g] = await Promise.all([fxJson(urls.f), fxJson(urls.h), urls.g ? fxJson(urls.g).catch(() => null) : null]);
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
function fxMoon(day, lat, lon) {
  if (!SUN || !SUN.getMoonTimes) return null;
  const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12);
  const ill = SUN.getMoonIllumination(noon);
  const t = SUN.getMoonTimes(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 1), lat, lon) || {};
  const ok = v => v instanceof Date && !isNaN(v) ? v : null;
  return { name: FX_PHASES.find(([lim]) => ill.phase < lim)[1], frac: Math.round(ill.fraction * 100), rise: ok(t.rise), set: ok(t.set), up: !!t.alwaysUp, down: !!t.alwaysDown };
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
/* Rut windows from the Utah DWR mule deer and elk management plans. */
const FX_RUT = {
  deer: [['11-10', '11-30', 2, 'strong', 'Mule deer rut, the Utah peak: bucks travel by day between doe groups.'], ['11-01', '11-09', 1, 'moderate', 'Mule deer pre-rut: bucks start checking doe groups and move more by day.'], ['12-01', '12-10', 1, 'moderate', 'Late rut: some bucks still cruising.']],
  elk: [['09-10', '09-30', 2, 'strong', 'Elk rut, the Utah peak: bulls bugle, gather cows and move by day.'], ['09-01', '09-09', 1, 'moderate', 'Early rut: bulls start gathering cows.'], ['10-01', '10-12', 1, 'moderate', 'Rut tailing off: bulls still with the cows.']]
};
/* General seasons that opened in the last three days for this species, from
   seasons.json. The extended archery hunts run for months and are left out. */
function fxOpeners(key, sp) {
  const S = typeof DB !== 'undefined' && DB && DB.seasons && DB.seasons.seasons || [];
  return S.filter(s => s.group === sp && !/ext/.test(s.id || '') && s.start && key >= s.start && key <= fxDay(new Date(Date.parse(s.start + 'T19:00:00Z') + 2 * 86400000).toISOString()));
}
function fxSignal(days, i, species, now) {
  const d = days[i], prev = days[i - 1] || null, prev2 = days[i - 2] || null, F = [];
  const sp = species === 'elk' ? 'elk' : 'deer', who = sp === 'elk' ? 'Elk' : 'Deer';
  const push = (k, dir, conf, why) => F.push({ k, dir, conf, why });
  const mmdd = d.key.slice(5), migration = mmdd >= '10-10' && mmdd <= '12-20';
  for (const [a, b, w, conf, why] of FX_RUT[sp]) if (mmdd >= a && mmdd <= b) { push('Rut', w, conf, why); break; }
  const opened = fxOpeners(d.key, sp);
  if (opened.length) push('Opening days', -1, sp === 'elk' ? 'strong' : 'moderate', sp === 'elk'
    ? `${opened[0].name} opened ${opened[0].start === d.key ? 'today' : fxLF.format(new Date(opened[0].start + 'T12:00:00'))}: hunters push elk off the roads and public land in the first days, about a tenth of a herd. Hunt away from the roads.`
    : `${opened[0].name} opened ${opened[0].start === d.key ? 'today' : fxLF.format(new Date(opened[0].start + 'T12:00:00'))}: bucks move off the roads into cover in the first days. Hunt away from the roads.`);
  if (migration && d.lo != null && d.lo <= 25) push('Hard freeze', 1, 'strong', `Low of ${d.lo}°: nights this cold are what start ${sp} moving down from summer range.`);
  if (d.snow >= 4) push('Storm snow', 1, 'strong', `About ${Math.round(d.snow)}" of snow: snow on the high country sends ${sp} downhill, and leaves tracks. About ten inches on the ground does it.`);
  else if (d.snow >= 1) push('Snow', 1, 'moderate', `About ${d.snow < 2 ? d.snow.toFixed(1) : Math.round(d.snow)}" of snow: fresh tracks, and the start of the push toward lower country.`);
  if (prev && d.hi != null && prev.hi != null) {
    const drop = prev.hi - d.hi;
    if (drop >= 10) push('Cold front', 1, 'weak', `The high falls ${drop}° from ${prev.name}. Hunters swear by it; the studies behind it are on whitetails, none on mule deer or elk.`);
    else if (d.hi - prev.hi >= 8) push('Warm-up', -1, 'weak', `${d.hi - prev.hi}° warmer than ${prev.name}: ${sp} bed earlier and move less by day.`);
  }
  if (prev && prev2 && prev.hi != null && prev2.hi != null && d.hi != null && prev2.hi - prev.hi >= 10 && d.pop < 30 && d.hi - prev.hi <= 5)
    push('Clearing after the storm', 1, 'weak', 'The first calm, cold day after a storm: animals get up to feed after sitting it out. Whitetail evidence; none on mule deer or elk.');
  const hot = sp === 'elk' ? 65 : 70;
  if (d.hi != null && d.hi >= hot + 10) push('Heat', -2, 'moderate', `High of ${d.hi}°: ${sp} are bedded in shade by mid-morning. First light, then the evening cool-down. No study gives a number; this is a rule of thumb.`);
  else if (d.hi != null && d.hi >= hot) push('Warm day', -1, 'moderate', `High of ${d.hi}°: daytime movement ends early. No study gives a number; ${hot}° is a rule of thumb.`);
  if (d.snow < 1 && d.pop >= 70 && /rain|showers|thunder|snow/i.test(d.words)) push('Steady precipitation', -1, 'weak', 'Heavy weather means more time bedded, and feeding once it stops.');
  const w = Math.max(d.wind || 0, d.gust || 0);
  if (w >= 18) push('Wind', 0, 'contested', `Wind to ${w} mph: no clear effect on how much ${sp} move. It matters for your approach and your hearing. Shown, not scored.`);
  if (d.moon && d.moon.name === 'Full') push('Full moon', 0, 'weak', 'A bright night. Hunters report slower mornings; a GPS study of 48 bucks found no change in movement with the moon. Shown, not scored.');
  const score = F.reduce((s, f) => s + f.dir, 0);
  const tier = score >= 3 ? 'Strong' : score >= 1 ? 'Good' : score >= -1 ? 'Fair' : 'Slow';
  let when = 'dawn', why = `First light: ${sp} move most in the first and last hours of light, and the morning is the colder, stiller one.`;
  const at = h => (d.hours || []).find(x => fxHour(x.s) === h), am = at(8), pm = at(16);
  if (am && pm) {
    if (pm.t != null && am.t != null && pm.t <= am.t - 6) { when = 'dusk'; why = `The front arrives during the day: by ${clock(new Date(pm.s))} it is ${am.t - pm.t}° colder than mid-morning.`; }
    else if ((am.pop || 0) >= 60 && (pm.pop || 0) < 30) { when = 'dusk'; why = 'The morning precipitation clears by afternoon; animals get up to feed as it does.'; }
    else if ((fxMph(am.w) || 0) >= 18 && (fxMph(pm.w) || 0) < 10) { when = 'dusk'; why = 'The wind lies down in the afternoon: a quieter stalk, and better hearing both ways.'; }
  }
  const L = d.light, t = now == null ? fxNow() : now, next = days[i + 1];
  let label = when === 'dawn' ? 'First light' : 'Last light', window = L ? (when === 'dawn' ? 'from ' + clock(L.start) : 'until ' + clock(L.late)) : '';
  if (i === 0 && L && t > L.late.getTime()) { when = 'next'; label = 'First light tomorrow'; window = next && next.light ? 'from ' + clock(next.light.start) : ''; why = 'Today is done. The next move is the first hour of light.'; }
  else if (i === 0 && L && t > L.sunrise.getTime() + 2 * 3600000) { when = 'dusk'; label = 'Last light'; window = 'until ' + clock(L.late); why = 'First light has passed. Last light is the next move.'; }
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
const fxLightNote = spot => `<p class="fine">Start is 30 minutes before sunrise; waterfowl ends at sunset, upland, turkey and big game 30 minutes after; on WMAs, state land beside the Great Salt Lake and federal refuges everything ends at sunset. Computed for ${spot.kind === 'unit' ? 'the centre of ' + esc(spot.label) : esc(spot.label)} and rounded to the safe side; an estimate. The guidebook table by county is the legal one.</p>`;
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
    <div class="sub">${esc(s.best.label)}${s.best.window ? ', ' + esc(s.best.window) : ''}. ${esc((s.factors.find(f => f.dir) || {}).why || s.best.why)}</div></div>`;
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
    <div class="sec-title" style="padding:0 16px">Best window</div><p class="fine" style="padding:4px 16px 0"><b>${esc(s.best.label)}${s.best.window ? ', ' + esc(s.best.window) : ''}.</b> ${esc(s.best.why)}</p>
    <div class="sec-title" style="padding:0 16px">What moves ${esc(s.who.toLowerCase())} this day</div>${fxFactors(s)}`;
  if (L) h += `<div class="sec-title" style="padding:0 16px">Legal light &middot; estimate</div>${fxLightStats(d)}
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
      <dt>First and last light &middot; strong</dt><dd>Mule deer and elk move most in the first and last hours of daylight. That is the frame for every day here; no study gives it in minutes, so neither does this.</dd>
      <dt>Rut &middot; strong</dt><dd>The Utah DWR management plans put the mule deer rut peak in mid to late November and the elk rut in mid to late September. Bucks and bulls travel by day then, whatever the weather. Scored +2 at the peak, +1 on the shoulders.</dd>
      <dt>Opening days &middot; strong for elk, moderate for deer</dt><dd>In the first days of a general season, elk leave roads and public land (about a tenth of a herd shifts) and bucks move off roads into cover. Scored &minus;1 on the opening day and the two after it, from the season dates in this app.</dd>
      <dt>Hard freeze and snow on the high country &middot; strong</dt><dd>Nights near 25 degrees and below, and about ten inches of snow on the ground, are what start mule deer and elk down from summer range from mid-October on. Scored +1 each from the forecast low and the forecast snowfall.</dd>
      <dt>Heat &middot; moderate</dt><dd>Warm days send deer and elk to shade by mid-morning; the direction is well supported, the number is not. 70 degrees for deer and 65 for elk are rules of thumb. Scored &minus;1, and &minus;2 ten degrees above that.</dd>
      <dt>Cold fronts &middot; weak</dt><dd>Hunters swear by a sharp drop in the daytime high, and by the first clear day after the storm. The studies behind it are on whitetails in the East and Midwest; there is none on mule deer or elk. Scored +1 each, not more.</dd>
      <dt>Steady precipitation &middot; weak</dt><dd>Heavy weather means more time bedded and feeding once it stops. Scored &minus;1.</dd>
      <dt>Wind &middot; contested</dt><dd>The research finds no clear effect of wind on how much deer and elk move. It matters for your approach and for hearing, both ways. Shown from 18 mph, not scored.</dd>
      <dt>Moon &middot; weak to none</dt><dd>Hunters report slower mornings after a bright night. A GPS study of 48 bucks found no change in movement with the phase or position of the moon. Shown, not scored.</dd>
      <dt>Barometric pressure &middot; contested</dt><dd>Pressure on its own predicts little; what hunters feel as "the pressure changing" is the front. Not scored, and not shown.</dd>
    </dl>
    <p class="fine" style="padding:12px 16px 0">Sources: the Utah DWR mule deer and elk management plans; Rittenhouse and others, 2015, on Wyoming mule deer migration, snow and cold; Mississippi State Extension on the moon, 2025; and the whitetail weather studies, named as such. Mule deer and elk are not whitetails: most movement-forecast research, and most of the apps, are built on whitetail data. This read uses Western studies where they exist and says "weak" or "contested" where they do not. It never claims a percentage.</p>`;
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
