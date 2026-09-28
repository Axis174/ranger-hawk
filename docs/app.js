/* Ranger Hawk - offline-first personal hunting reference. */
'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const DAY = 86400000;
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const d0 = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const days = (a, b) => Math.round((b - a) / DAY);
const fmt = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const GC = { bird: 'var(--bird)', deer: 'var(--deer)', elk: 'var(--elk)', turkey: 'var(--turkey)', smallgame: 'var(--small)' };

let DB = { birds: [], seasons: null, config: null, community: null, lake: null, snow: null };
let LOT = null, lotState = 'UT';
let SUN = null;          // SunCalc module, loaded after first paint
let UNITS = null;        // hunt unit shapes, loaded the first time GPS is used
let home = 'nsl';
let tab = 'today';
let query = '';
let speciesFilter = new Set();

try { home = localStorage.getItem('ha.home') || 'nsl'; } catch (e) { /* private mode */ }

/* ---------------------------------------------------------------- data ---- */
async function load() {
  const grab = async (f, dflt) => {
    try {
      const r = await fetch('data/' + f, { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      return j && j.offline ? dflt : j;
    } catch (e) { return dflt; }
  };
  const [b, s, c, com, lake, snow] = await Promise.all([
    grab('bird_access.json', []), grab('seasons.json', null),
    grab('config.json', null), grab('community.json', null),
    grab('lake_level.json', null), grab('snow.json', null)
  ]);
  DB = { birds: b || [], seasons: s, config: c, community: com, lake: lake, snow: snow };
  /* The map popup, the Contacts list and the fishing place sheet all build their HTML
     synchronously and ask acFor() while doing it, so none of them can wait for a fetch.
     Priming screen by screen missed the fishing sheet; priming once here cannot. */
  if (typeof acLoad === 'function') acLoad();
  if (!DB.seasons || !DB.config) {
    $('view').innerHTML = '<p class="empty">Data could not load and nothing is cached yet.' +
      '<br>Open this once with a connection, then it works offline.</p>';
    return false;
  }
  return true;
}

/* -------------------------------------------------------------- derive ---- */
function seasonState(s) {
  const t = today(), a = d0(s.start), b = d0(s.end);
  if (t >= a && t <= b) return { k: 'open', n: days(t, b), label: 'Open, ' + days(t, b) + 'd left' };
  if (t < a) { const n = days(t, a); return { k: n <= 21 ? 'soon' : 'shut', n, label: 'Opens in ' + n + 'd' }; }
  return { k: 'shut', n: -1, label: 'Closed' };
}
function deadlineState(dl) {
  const n = days(today(), d0(dl.date));
  const lead = Math.max(...(dl.lead_days || [7]));
  return { n, k: n < 0 ? 'shut' : n <= 3 ? 'crit' : n <= lead ? 'soon' : 'open' };
}
function upcoming() {
  return (DB.seasons.deadlines || [])
    .map(d => ({ d, st: deadlineState(d) }))
    .filter(x => x.st.n >= 0)
    .sort((a, b) => a.st.n - b.st.n);
}
function openNow() {
  return (DB.seasons.seasons || [])
    .map(s => ({ s, st: seasonState(s) }))
    .filter(x => x.st.k === 'open')
    .sort((a, b) => a.st.n - b.st.n);
}
function alerts() {
  return upcoming().filter(x => x.st.k === 'crit' || x.st.k === 'soon').length;
}
function drive(p) {
  const d = (p.drive || {})[home];
  /* Points added straight from UDWR's property layer have no routed time - there
     is no routing engine here and inventing minutes would be a lie. Show the
     straight-line miles instead, labelled as miles so it cannot be mistaken for
     a drive, and sort them against the routed ones on a rough 43 mph. */
  if (!d) {
    const h = (DB.config.homes || []).find(x => x.id === home);
    if (!h || p.lat == null) return { txt: '--', sub: '', mins: 1e9 };
    const mi = miles(h.lat, h.lon, p.lat, p.lon);
    return { txt: mi.toFixed(0), sub: 'mi', mins: mi * 1.4 };
  }
  if (d.range) return { txt: d.range[0] + '-' + d.range[1], sub: 'min *', mins: d.range[0] };
  return { txt: String(d.min), sub: 'min', mins: d.min };
}

/* ---------------------------------------------------------- legal light ---- */
/* UDWR publishes shooting hours from "official" sunrise and sunset at Salt Lake
   City, then shifts them a few minutes by county. This computes the Salt Lake
   City figure with SunCalc and rounds toward the safe side: start rounds up,
   end rounds down. It is an estimate - the guidebook table is the legal one. */
const SLC = { lat: 40.7608, lon: -111.8910 };
const clock = d => d.toLocaleTimeString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' });
function legalLight(day) {
  if (!SUN) return null;
  const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12);
  const t = SUN.getTimes(noon, SLC.lat, SLC.lon);
  if (!t || !t.sunrise || isNaN(t.sunrise) || isNaN(t.sunset)) return null;
  const up = ms => new Date(Math.ceil(ms / 60000) * 60000);
  const dn = ms => new Date(Math.floor(ms / 60000) * 60000);
  const H = 30 * 60000;
  return {
    start: up(t.sunrise.getTime() - H),
    sunrise: up(t.sunrise.getTime()),
    sunset: dn(t.sunset.getTime()),
    late: dn(t.sunset.getTime() + H)
  };
}
function cardLight() {
  const L = legalLight(today());
  if (!L) return '';
  return `<div class="sec-title">Legal light today &middot; estimate</div><div class="card">
    <div class="stats">
      <div class="stat"><div class="k">Start (all)</div><div class="v">${clock(L.start)}</div></div>
      <div class="stat"><div class="k">Waterfowl ends</div><div class="v">${clock(L.sunset)}</div></div>
      <div class="stat"><div class="k">Upland, big game</div><div class="v">${clock(L.late)}</div></div>
    </div>
    <p class="fine">Start is 30 minutes before sunrise. Waterfowl ends at sunset; upland, turkey and big game
    end 30 minutes after. On WMAs, state land beside the Great Salt Lake and federal refuges, everything ends at
    sunset. Computed for Salt Lake City and rounded to the safe side. The guidebook table shifts a few minutes by
    county and is the legal one.</p></div>`;
}

/* ------------------------------------------------------------ lake level ---- */
function cardLake() {
  const k = DB.lake;
  if (!k || !k.sites || !k.sites.length) return '';
  const s = k.sites.find(x => x.site === '10010000') || k.sites[0];
  const ref = k.reference || {};
  const ch = s.change_30d_ft;
  const over = ref.record_low_ft ? (s.elev_ft - ref.record_low_ft) : null;
  return `<div class="sec-title">Great Salt Lake level</div><div class="card">
    <div class="stats">
      <div class="stat"><div class="k">South arm</div><div class="v">${s.elev_ft.toFixed(1)} ft</div></div>
      <div class="stat"><div class="k">30-day change</div><div class="v">${ch > 0 ? '+' : ''}${ch.toFixed(2)} ft</div></div>
      ${over != null ? `<div class="stat"><div class="k">Above record low</div><div class="v">${over.toFixed(1)} ft</div></div>` : ''}
    </div>
    <p class="fine">USGS gauge at Saltair, read ${esc(fmt(new Date(s.at)))}. ${ref.record_low_ft ? `Record low ${ref.record_low_ft} ft (${esc(ref.record_low_when || '')}). ` : ''}${esc(ref.note || '')}
    A low lake means dry outer marsh units and longer walks to water; call the WMA before a long drive.</p></div>`;
}

/* ------------------------------------------------------------------ snow ---- */
function cardSnow() {
  const k = DB.snow;
  if (!k || !k.stations || !k.stations.length) return '';
  return `<div class="sec-title">Snow in the high country</div><div class="card">
    <div class="stats">${k.stations.map(s => `<div class="stat"><div class="k">${esc(s.name)}</div>
      <div class="v">${s.depth_in == null ? '--' : s.depth_in + ' in'}</div></div>`).join('')}</div>
    <p class="fine">Snow depth at USDA SNOTEL gauges, read ${esc(k.stations[0].date || '')}. ${k.stations.map(s => `${esc(s.name)}: ${esc(s.where)}, ${Number(s.elev_ft).toLocaleString()} ft`).join('. ')}.
    Trial Lake sits beside the Mirror Lake Highway, the ptarmigan road, which closes for winter once snow sticks.</p></div>`;
}

/* -------------------------------------------------------------- where am I -- */
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function unitsAt(lon, lat) {
  return (UNITS || []).filter(u =>
    lon >= u.bb[0] && lon <= u.bb[2] && lat >= u.bb[1] && lat <= u.bb[3] &&
    u.p.some(poly => inRing(lon, lat, poly[0]) && !poly.slice(1).some(h => inRing(lon, lat, h))));
}
function miles(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}
async function whereAmI() {
  openSheet('<h3>Where am I</h3><p class="where">Getting a GPS fix. This works with no cell signal.</p>');
  if (!navigator.geolocation) { openSheet('<h3>Where am I</h3><p class="where">This phone is not sharing location with the app.</p>'); return; }
  if (!UNITS) {
    try {
      const r = await fetch('data/units_geo.json');
      const j = await r.json();
      UNITS = j && j.units ? j.units : null;
    } catch (e) { UNITS = null; }
  }
  navigator.geolocation.getCurrentPosition(pos => {
    const lat = pos.coords.latitude, lon = pos.coords.longitude;
    const hits = UNITS ? unitsAt(lon, lat) : null;
    const near = DB.birds.map(p => ({ p, mi: miles(lat, lon, p.lat, p.lon) })).sort((a, b) => a.mi - b.mi).slice(0, 4);
    openSheet(`<h3>Where am I</h3>
      <p class="where mono">${lat.toFixed(5)}, ${lon.toFixed(5)} &middot; within ${Math.round(pos.coords.accuracy)} m</p>
      <div class="acts"><button class="btn ghost" data-copy="${lat.toFixed(5)}, ${lon.toFixed(5)}">Copy coordinates</button></div>
      <dl class="f"><dt>Big game hunt boundaries here</dt><dd>${
        hits == null ? 'Unit shapes are not on this phone yet. Open the app once with a signal.'
        : hits.length ? hits.map(u => esc(u.n)).join('<br>')
        : 'None found. You may be outside Utah or on a unit edge.'}</dd>
      <dt>Closest access points</dt><dd>${near.map(x => `${esc(x.p.name)} &middot; ${x.mi.toFixed(1)} mi`).join('<br>')}</dd></dl>
      <div class="warnbox" style="margin:14px 16px 0">Boundaries are simplified to about 200 m, and one spot can sit inside
      several overlapping hunts. Near an edge, trust the Utah Hunt Planner and your permit, not this.</div>`);
  }, err => {
    openSheet(`<h3>Where am I</h3><p class="where">No GPS fix: ${esc(err.message || 'location was refused')}.
      Allow location for this app in the phone settings and try again.</p>`);
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
}

/* ------------------------------------------------------------- forecast ---- */
/* National Weather Service - public domain, no key. Needs a signal; the rest of
   the sheet does not wait for it. */
async function loadWx(lat, lon) {
  const box = $('wx');
  if (!box) return;
  if (!navigator.onLine) { box.innerHTML = '<dt>Forecast</dt><dd>Needs a signal.</dd>'; return; }
  try {
    const key = 'ha.wx.' + lat.toFixed(2) + ',' + lon.toFixed(2);
    let url = null;
    try { url = localStorage.getItem(key); } catch (e) { /* private mode */ }
    if (!url) {
      const pt = await (await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`)).json();
      url = pt.properties.forecast;
      try { localStorage.setItem(key, url); } catch (e) { /* private mode */ }
    }
    const fc = await (await fetch(url)).json();
    const rows = fc.properties.periods.slice(0, 4).map(p =>
      `<b>${esc(p.name)}</b>: ${esc(p.temperature)}&deg;${esc(p.temperatureUnit)}, wind ${esc(p.windSpeed)} ${esc(p.windDirection)}. ${esc(p.shortForecast)}`);
    if (!$('wx')) return;
    $('wx').innerHTML = `<dt>Forecast &middot; National Weather Service</dt><dd>${rows.join('<br>')}</dd>`;
  } catch (e) {
    if ($('wx')) $('wx').innerHTML = '<dt>Forecast</dt><dd>Could not reach the National Weather Service.</dd>';
  }
}

/* ------------------------------------------------------------------ map ---- */
/* MapLibre GL + a single Protomaps PMTiles file for all of Utah (zoom 0-13, with
   dirt tracks and trails). Libraries load only when the Map tab is opened. The
   service worker answers the map's byte-range reads from the saved copy, so once
   "Save map for offline" has run, the whole thing works with no signal. */
const MAP_FILE = 'maps/utah.pmtiles';
const LAND_FILE = 'maps/land.pmtiles';      // Utah Trust Lands ownership, cut with tippecanoe
const MVUM_FILE = 'maps/mvum.pmtiles';      // USFS Motor Vehicle Use Map: legal roads and motorized trails
const BLM_FILE = 'maps/blm.pmtiles';        // BLM Utah: designated routes + area-wide travel rules (open / limited / closed)
/* Elevation (Mapterhorn, terrarium-encoded, 512 px tiles). All of Utah to zoom 10
   (about 58 m per pixel) plus zoom 11 (about 29 m) for the Wasatch-Uintas-Box Elder
   and Boulder-Fishlake blocks, plus zoom 12 (about 15 m) for Boulder Mountain and the
   Wasatch-Uintas core. maplibre-contour turns it into contour lines on the
   phone; MapLibre shades the hills from the same tiles. */
const DEM_FILES = ['maps/terrain-utah.pmtiles', 'maps/terrain-detail.pmtiles', 'maps/terrain-sharp.pmtiles'];   // zoom 0-10, 11, 12
const DEM_MAXZOOM = 12;
const MAP_CACHE = 'ranger-hawk-maps';
const MAP_ASSETS = ['vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'vendor/pmtiles.js', 'vendor/basemaps.js', 'vendor/maplibre-contour.js',
  'maps/sprites/light.json', 'maps/sprites/light.png', 'maps/sprites/light@2x.json', 'maps/sprites/light@2x.png',
  'data/units_geo.json', 'data/raw_dwr_properties.json', 'data/raw_wia_properties.json']
  .concat(['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'].flatMap(f =>
    ['0-255', '256-511', '8192-8447'].map(r => 'maps/fonts/' + encodeURIComponent(f) + '/' + r + '.pbf')));
let MAP = null, mapLibs = null;
const abs = rel => new URL(rel, location.href).href;
/* Ownership colours follow the convention hunters already know from BLM maps. */
const LAND = [
  ['blm', 'BLM', '#F2D35B'], ['usfs', 'National Forest', '#7DB86B'], ['sitla', 'State trust (SITLA)', '#5B9BD5'],
  ['dwr', 'DWR', '#2E8B7A'], ['statepark', 'State park', '#A58BD0'], ['state_other', 'Other state', '#B9C7E4'],
  ['nps', 'National Park', '#C49A6C'], ['usfws', 'Wildlife refuge', '#6CC5BE'], ['fed_other', 'Other federal', '#D9C9A3'],
  ['military', 'Military', '#D9766C'], ['tribal', 'Tribal', '#E59B5C'], ['private', 'Private', '#FFFFFF']
];
const LAND_NOTE = { private: 'Private. Written permission required.', tribal: 'Tribal land. A state permit does not cover it.',
  nps: 'National Park. No hunting.', military: 'Military. Closed.', sitla: 'State trust land. Generally open to hunting; check for leases and closures.' };
let landOn = true, roadsOn = true, veh = 't', keyOn = false, terrainOn = true;
try { landOn = localStorage.getItem('ha.land') !== '0'; roadsOn = localStorage.getItem('ha.mvum') !== '0'; veh = localStorage.getItem('ha.veh') === 'a' ? 'a' : 't'; terrainOn = localStorage.getItem('ha.terrain') !== '0'; } catch (e) { /* private mode */ }
const MV = { open: '#1E8E3E', closed: '#C62828', no: '#8C8C8C', ask: '#E08A00' };
const mmdd = () => { const n = new Date(); return (n.getMonth() + 1) * 100 + n.getDate(); };
/* Colour a forest road by whether the chosen vehicle may legally be on it today.
   Windows are stored as month*100+day; a window that wraps the new year has
   open > close, so it is "inside" when today is after open OR before close. */
function mvColor() {
  const T = mmdd(), o = ['get', veh + 'o'], c = ['get', veh + 'c'];
  return ['case', ['==', ['get', 'u'], 1], MV.ask, ['!', ['has', veh + 'o']], MV.no,
    ['<=', o, c], ['case', ['all', ['>=', T, o], ['<=', T, c]], MV.open, MV.closed],
    ['case', ['any', ['>=', T, o], ['<=', T, c]], MV.open, MV.closed]];
}
function mvStatus(pr) {
  const o = pr[veh + 'o'], c = pr[veh + 'c'], T = mmdd(), who = veh === 't' ? 'trucks' : 'ATVs';
  if (pr.u === 1) return { k: 'ask', txt: 'Limited - read the note' };
  if (pr.nm === 1) return { k: 'no', txt: 'No motor vehicles' };
  if (o == null) return { k: 'no', txt: 'Not open to ' + who };
  const open = o <= c ? (T >= o && T <= c) : (T >= o || T <= c);
  const f = n => String(Math.floor(n / 100)).padStart(2, '0') + '/' + String(n % 100).padStart(2, '0');
  if (o === 101 && c === 1231) return { k: 'open', txt: 'Open all year to ' + who };
  return open ? { k: 'open', txt: 'Open today to ' + who + ' (closes after ' + f(c) + ')' }
              : { k: 'closed', txt: 'CLOSED today to ' + who + ' (open ' + f(o) + ' to ' + f(c) + ')' };
}
const SPC = { duck: '#1D95CA', pheasant: '#A0522D', chukar: '#8A6D1F', ptarmigan: '#5B5F97' };

function addScript(src) {
  return new Promise((ok, no) => { const el = document.createElement('script'); el.src = src; el.onload = ok; el.onerror = no; document.head.appendChild(el); });
}
function loadMapLibs() {
  if (!mapLibs) {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/maplibre-gl.css'; document.head.appendChild(css);
    mapLibs = addScript('vendor/maplibre-gl.js').then(() => Promise.all([addScript('vendor/pmtiles.js'), addScript('vendor/basemaps.js'), addScript('vendor/maplibre-contour.js')]))
      .catch(e => { mapLibs = null; throw e; });
  }
  return mapLibs;
}
async function allSaved(files) {
  try { const c = await caches.open(MAP_CACHE); for (const f of files) if (!(await c.match(abs(f)))) return false; return true; } catch (e) { return false; }
}
const BASE_FILES = [[MVUM_FILE, 'forest roads', 3400000], [BLM_FILE, 'BLM roads', 8000000], [LAND_FILE, 'land ownership', 6500000], [MAP_FILE, 'map', 65452871]];
const TERRAIN_FILES = [[DEM_FILES[2], 'sharp terrain', 63000000], [DEM_FILES[1], 'terrain detail', 40500000], [DEM_FILES[0], 'terrain', 59800000]];
const mapSaved = () => allSaved(BASE_FILES.map(f => f[0]));
const terrainSaved = () => allSaved(TERRAIN_FILES.map(f => f[0]));
function vMap() {
  return `<div class="mapwrap"><div id="map"></div>
    <div class="legend" id="legend"></div>
    <div class="mapbar"><span class="chips">
      <button class="chip" data-landtoggle="1" id="landbtn" aria-pressed="${landOn}">Land</button>
      <button class="chip" data-roadstoggle="1" id="roadsbtn" aria-pressed="${roadsOn}">Roads</button>
      <button class="chip" data-terraintoggle="1" id="terrainbtn" aria-pressed="${terrainOn}">Terrain</button>
      <button class="chip" data-veh="t" aria-pressed="${veh === 't'}">Truck</button><button class="chip" data-veh="a" aria-pressed="${veh === 'a'}">ATV</button>
      <button class="chip" data-keytoggle="1" id="keybtn" aria-pressed="${keyOn}">Key</button>
    </span></div>
    <div class="mapbar"><span id="mapstate">Loading map&hellip;</span>
    <button class="btn ghost" id="mapsave" data-mapsave="base" hidden>Save map &middot; 83 MB</button>
    <button class="btn ghost" id="demsave" data-mapsave="terrain" hidden>Save terrain &middot; 163 MB</button></div></div>`;
}
async function refreshMapBar(msg) {
  if (!$('mapstate')) return;
  const [base, dem] = await Promise.all([mapSaved(), terrainSaved()]);
  if (!$('mapstate')) return;
  $('mapstate').textContent = msg || (base && dem ? 'Map and terrain saved. Works with no signal.'
    : base ? 'Map saved. Terrain still needs a signal.' : 'Map is streaming. Save it before you lose signal.');
  const can = 'caches' in window;
  $('mapsave').hidden = base || !can;
  $('demsave').hidden = dem || !can;
}
async function saveMap(which) {
  const files = which === 'terrain' ? TERRAIN_FILES : BASE_FILES;
  const b = $(which === 'terrain' ? 'demsave' : 'mapsave');
  b.disabled = true;
  try {
    const c = await caches.open(MAP_CACHE);
    await Promise.allSettled(MAP_ASSETS.map(u => c.add(new Request(u, { cache: 'reload' }))));
    for (const [file, label, guess] of files) {
      const r = await fetch(file, { cache: 'reload' });
      if (!r.ok || !r.body) throw new Error('download failed');
      const total = +r.headers.get('content-length') || guess;
      const rd = r.body.getReader(); const parts = []; let got = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        parts.push(value); got += value.length;
        if ($('mapstate')) $('mapstate').textContent = 'Saving ' + label + ': ' + Math.round(got / total * 100) + '%';
      }
      await c.put(abs(file), new Response(new Blob(parts), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(got) } }));
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    refreshMapBar();
  } catch (e) {
    if ($('mapstate')) $('mapstate').textContent = 'Could not save: ' + (e.message || e) + '. Try again on Wi-Fi.';
  }
  if (b) b.disabled = false;
}
/* Elevation tiles come out of two PMTiles files. Where the zoom-11 detail file has
   no tile (outside the two detail blocks), the zoom-10 parent is cut into its
   quadrant and doubled with no smoothing - smoothing would blend the three colour
   channels separately and corrupt the encoded heights. */
function demSource() {
  if (demSource.src) return demSource.src;
  const arch = DEM_FILES.map(f => new pmtiles.PMTiles(abs(f)));      // [zoom 0-10, zoom 11, zoom 12]
  // A tile as a Blob: from the file that owns that zoom if it has one, otherwise the
  // parent tile's quadrant doubled with smoothing off (recursively, so a zoom-12
  // tile outside every detail block is built from zoom 10).
  async function tile(z, x, y, signal) {
    const t = await arch[Math.max(0, z - 10)].getZxy(z, x, y, signal);
    if (t && t.data) return new Blob([t.data], { type: 'image/webp' });
    if (z <= 10) return null;
    const par = await tile(z - 1, x >> 1, y >> 1, signal);
    if (!par) return null;
    const bmp = await createImageBitmap(par, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const n = bmp.width, h = n / 2, cv = document.createElement('canvas');
    cv.width = cv.height = n;
    const cx = cv.getContext('2d'); cx.imageSmoothingEnabled = false;
    cx.drawImage(bmp, (x & 1) * h, (y & 1) * h, h, h, 0, 0, n, n);
    return new Promise(ok => cv.toBlob(ok, 'image/png'));
  }
  const src = new mlcontour.DemSource({ url: 'rhdem/{z}/{x}/{y}', encoding: 'terrarium', maxzoom: DEM_MAXZOOM, worker: false, cacheSize: 120, timeoutMs: 20000 });
  src.manager.getTile = async (url, ac) => {
    const [z, x, y] = url.split('/').slice(-3).map(Number);
    const data = await tile(z, x, y, ac && ac.signal);
    if (!data) throw new Error('no elevation tile ' + z + '/' + x + '/' + y);
    return { data };
  };
  src.setupMaplibre(maplibregl);
  demSource.src = src;
  return src;
}
const TERRAIN_LAYERS = ['hills', 'contour-line', 'contour-label'];
function toggleTerrain() {
  terrainOn = !terrainOn;
  try { localStorage.setItem('ha.terrain', terrainOn ? '1' : '0'); } catch (e) { /* private mode */ }
  if (MAP && MAP.getStyle()) TERRAIN_LAYERS.forEach(id => MAP.getLayer(id) && MAP.setLayoutProperty(id, 'visibility', terrainOn ? 'visible' : 'none'));
  if ($('terrainbtn')) $('terrainbtn').setAttribute('aria-pressed', terrainOn);
}
/* The stock style draws dirt tracks and trails almost white. For hunting they are
   the point, so tracks become a brown dashed line, foot paths a dotted one, and
   small-road names show two zoom levels sooner. */
function huntLayers() {
  const L = basemaps.layers('protomaps', basemaps.namedFlavor('light'), { lang: 'en' });
  const out = [];
  for (const l of L) {
    if (l.id === 'roads_other') {
      out.push(Object.assign({}, l, { id: 'hunt_tracks', filter: ['all', l.filter, ['!=', 'kind_detail', 'path'], ['!=', 'kind_detail', 'footway']],
        paint: { 'line-color': '#8A5A2B', 'line-dasharray': [3, 1.5], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 13, 1.6, 16, 3] } }));
      out.push(Object.assign({}, l, { id: 'hunt_paths', filter: ['all', l.filter, ['in', 'kind_detail', 'path', 'footway']],
        paint: { 'line-color': '#8A5A2B', 'line-dasharray': [1, 1.5], 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 14, 1.4, 16, 2.4] } }));
      continue;
    }
    if (l.id === 'roads_minor') l.paint = Object.assign({}, l.paint, { 'line-color': '#ffffff' });
    if (l.id === 'roads_minor_casing') l.paint = Object.assign({}, l.paint, { 'line-color': '#b9b3a6' });
    if (l.id === 'roads_labels_minor') l.minzoom = 13;
    out.push(l);
  }
  // Ownership goes under the roads and labels so they stay readable on top of it.
  const at = out.findIndex(l => /^roads_/.test(l.id));
  const vis = landOn ? 'visible' : 'none';
  const tv = terrainOn ? 'visible' : 'none';
  out.splice(at < 0 ? out.length : at, 0,
    { id: 'hills', type: 'hillshade', source: 'dem', layout: { visibility: tv },
      paint: { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#3a3a32', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#5a5a4a' } },
    { id: 'land-fill', type: 'fill', source: 'land', 'source-layer': 'land', layout: { visibility: vis },
      filter: ['!=', 'c', 'private'],
      paint: { 'fill-opacity': 0.42, 'fill-color': ['match', ['get', 'c']].concat(LAND.flatMap(l => [l[0], l[2]]), ['#cccccc']) } },
    { id: 'land-private', type: 'fill', source: 'land', 'source-layer': 'land', layout: { visibility: vis },
      filter: ['==', 'c', 'private'], paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.55 } },
    { id: 'land-line', type: 'line', source: 'land', 'source-layer': 'land', minzoom: 9, layout: { visibility: vis },
      paint: { 'line-color': '#5a5a4a', 'line-opacity': 0.45, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.3, 13, 1] } },
    { id: 'contour-line', type: 'line', source: 'contours', 'source-layer': 'contours', minzoom: 11, layout: { visibility: tv },
      paint: { 'line-color': '#7A5230', 'line-opacity': ['match', ['get', 'level'], 1, 0.75, 0.4], 'line-width': ['match', ['get', 'level'], 1, 1.1, 0.5] } });
  // Legal forest roads sit above the base roads and below the road names.
  const lb = out.findIndex(l => l.type === 'symbol' && /^roads_/.test(l.id));
  const rv = roadsOn ? 'visible' : 'none';
  const w = ['interpolate', ['linear'], ['zoom'], 8, 0.8, 11, 1.8, 14, 3.4];
  out.splice(lb < 0 ? out.length : lb, 0,
    { id: 'blm-closed', type: 'fill', source: 'blm', 'source-layer': 'areas', layout: { visibility: rv }, filter: ['==', 'd', 'Closed'],
      paint: { 'fill-color': '#C62828', 'fill-opacity': 0.13 } },
    { id: 'blm-areas', type: 'fill', source: 'blm', 'source-layer': 'areas', layout: { visibility: rv }, filter: ['!=', 'd', 'Closed'],
      paint: { 'fill-color': '#000000', 'fill-opacity': 0.01 } },
    { id: 'blm-casing', type: 'line', source: 'blm', 'source-layer': 'routes', minzoom: 9, layout: { visibility: rv, 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-opacity': 0.8, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.4, 11, 2.8, 14, 5] } },
    { id: 'blm-road', type: 'line', source: 'blm', 'source-layer': 'routes', filter: ['==', 'k', 'r'], layout: { visibility: rv, 'line-cap': 'round' },
      paint: { 'line-color': mvColor(), 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.5, 11, 1.5, 14, 3] } },
    { id: 'blm-trail', type: 'line', source: 'blm', 'source-layer': 'routes', filter: ['==', 'k', 't'], layout: { visibility: rv },
      paint: { 'line-color': mvColor(), 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.5, 11, 1.5, 14, 3], 'line-dasharray': [2, 1.2] } },
    { id: 'mvum-casing', type: 'line', source: 'mvum', 'source-layer': 'mvum', layout: { visibility: rv, 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.6, 11, 3.2, 14, 5.6] } },
    { id: 'mvum-road', type: 'line', source: 'mvum', 'source-layer': 'mvum', filter: ['==', 'k', 'r'], layout: { visibility: rv, 'line-cap': 'round' },
      paint: { 'line-color': mvColor(), 'line-width': w } },
    { id: 'mvum-trail', type: 'line', source: 'mvum', 'source-layer': 'mvum', filter: ['==', 'k', 't'], layout: { visibility: rv },
      paint: { 'line-color': mvColor(), 'line-width': w, 'line-dasharray': [2, 1.2] } },
    { id: 'contour-label', type: 'symbol', source: 'contours', 'source-layer': 'contours', minzoom: 12, filter: ['==', ['get', 'level'], 1],
      layout: { visibility: tv, 'symbol-placement': 'line', 'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' ft'], 'text-font': ['Noto Sans Italic'], 'text-size': 10, 'symbol-spacing': 380 },
      paint: { 'text-color': '#6B4423', 'text-halo-color': '#fff', 'text-halo-width': 1.4 } },
    { id: 'blm-name', type: 'symbol', source: 'blm', 'source-layer': 'routes', minzoom: 12, filter: ['has', 'n'],
      layout: { visibility: rv, 'symbol-placement': 'line', 'text-field': ['get', 'n'], 'text-font': ['Noto Sans Medium'], 'text-size': 10, 'symbol-spacing': 420 },
      paint: { 'text-color': '#1c1c1c', 'text-halo-color': '#fff', 'text-halo-width': 1.6 } },
    { id: 'mvum-num', type: 'symbol', source: 'mvum', 'source-layer': 'mvum', minzoom: 11,
      layout: { visibility: rv, 'symbol-placement': 'line', 'text-field': ['get', 'id'], 'text-font': ['Noto Sans Medium'], 'text-size': 10, 'symbol-spacing': 320 },
      paint: { 'text-color': '#1c1c1c', 'text-halo-color': '#fff', 'text-halo-width': 1.6 } });
  return out;
}
const MV_LAYERS = ['mvum-casing', 'mvum-road', 'mvum-trail', 'mvum-num', 'blm-closed', 'blm-areas', 'blm-casing', 'blm-road', 'blm-trail', 'blm-name'];
const ROAD_LINES = ['mvum-road', 'mvum-trail', 'blm-road', 'blm-trail'];
function drawLegend() {
  const el = $('legend'); if (!el) return;
  const who = veh === 't' ? 'truck' : 'ATV';
  el.innerHTML = (roadsOn ? `<span><i style="background:${MV.open}"></i>Open today (${who})</span><span><i style="background:${MV.closed}"></i>Closed today</span><span><i style="background:${MV.no}"></i>Not for ${who}s</span><span><i style="background:${MV.ask}"></i>Limited, tap to read</span><span><i style="background:#C62828;opacity:.3"></i>BLM closed area</span><span class="brk"></span>` : '') +
    (landOn ? LAND.map(l => `<span><i style="background:${l[2]}"></i>${l[1]}</span>`).join('') : '');
  el.hidden = !keyOn || (!roadsOn && !landOn);
  if (MAP) setTimeout(() => MAP && MAP.resize(), 0);
}
function toggleRoads() {
  roadsOn = !roadsOn;
  try { localStorage.setItem('ha.mvum', roadsOn ? '1' : '0'); } catch (e) { /* private mode */ }
  if (MAP && MAP.getStyle()) MV_LAYERS.forEach(id => MAP.getLayer(id) && MAP.setLayoutProperty(id, 'visibility', roadsOn ? 'visible' : 'none'));
  if ($('roadsbtn')) $('roadsbtn').setAttribute('aria-pressed', roadsOn);
  drawLegend();
}
function setVeh(v) {
  veh = v === 'a' ? 'a' : 't';
  try { localStorage.setItem('ha.veh', veh); } catch (e) { /* private mode */ }
  if (MAP && MAP.getStyle()) ROAD_LINES.forEach(id => MAP.getLayer(id) && MAP.setPaintProperty(id, 'line-color', mvColor()));
  document.querySelectorAll('[data-veh]').forEach(b => b.setAttribute('aria-pressed', b.dataset.veh === veh));
  drawLegend();
}
function toggleLand() {
  landOn = !landOn;
  try { localStorage.setItem('ha.land', landOn ? '1' : '0'); } catch (e) { /* private mode */ }
  if (MAP && MAP.getStyle()) ['land-fill', 'land-private', 'land-line'].forEach(id => MAP.getLayer(id) && MAP.setLayoutProperty(id, 'visibility', landOn ? 'visible' : 'none'));
  if ($('landbtn')) $('landbtn').setAttribute('aria-pressed', landOn);
  drawLegend();
}
async function initMap() {
  if (!$('map')) return;
  try { await loadMapLibs(); } catch (e) { $('mapstate').textContent = 'The map needs one visit with a signal before it works offline.'; return; }
  if (!$('map')) return;
  if (!initMap.proto) { const pr = new pmtiles.Protocol(); maplibregl.addProtocol('pmtiles', pr.tile); initMap.proto = true; }
  const h = (DB.config.homes || []).find(x => x.id === home) || { lat: 40.76, lon: -111.89 };
  let view = null; try { view = JSON.parse(localStorage.getItem('ha.mapview')); } catch (e) { /* none */ }
  MAP = new maplibregl.Map({
    container: 'map', attributionControl: { compact: true },
    center: view ? view.c : [h.lon, h.lat], zoom: view ? view.z : 9, maxZoom: 16.5,
    maxBounds: [[-116.5, 35.5], [-106.5, 43.5]],
    style: {
      version: 8,
      glyphs: abs('maps/fonts/') + '{fontstack}/{range}.pbf',
      sprite: abs('maps/sprites/light'),
      sources: {
        dem: { type: 'raster-dem', tiles: [demSource().sharedDemProtocolUrl], encoding: 'terrarium', tileSize: 512, maxzoom: DEM_MAXZOOM,
          attribution: 'Terrain: <a href="https://mapterhorn.com/attribution">Mapterhorn</a>' },
        contours: { type: 'vector', maxzoom: 15, tiles: [demSource().contourProtocolUrl({ multiplier: 3.28084, overzoom: 1,
          thresholds: { 11: [200, 1000], 12: [100, 500], 13: [100, 500], 14: [40, 200] },
          elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours' })] },
        blm: { type: 'vector', url: 'pmtiles://' + abs(BLM_FILE), attribution: 'BLM' },
        mvum: { type: 'vector', url: 'pmtiles://' + abs(MVUM_FILE), attribution: 'Roads: USFS MVUM' }, land: { type: 'vector', url: 'pmtiles://' + abs(LAND_FILE), attribution: 'Land: Utah Trust Lands' }, protomaps: { type: 'vector', url: 'pmtiles://' + abs(MAP_FILE),
        attribution: '<a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>' } },
      layers: huntLayers()
    }
  });
  MAP.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
  MAP.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: true }), 'top-right');
  MAP.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
  MAP.on('moveend', () => { try { const c = MAP.getCenter(); localStorage.setItem('ha.mapview', JSON.stringify({ c: [c.lng, c.lat], z: MAP.getZoom() })); } catch (e) { /* private mode */ } });
  MAP.on('load', async () => {
    const grab = async f => { try { const j = await (await fetch('data/' + f)).json(); return j && !j.offline ? j : null; } catch (e) { return null; } };
    const [dwr, wia, ug] = await Promise.all([grab('raw_dwr_properties.json'), grab('raw_wia_properties.json'), grab('units_geo.json')]);
    if (!MAP || !MAP.getStyle()) return;
    if (dwr) {
      MAP.addSource('dwr', { type: 'geojson', data: dwr });
      MAP.addLayer({ id: 'dwr-fill', type: 'fill', source: 'dwr', paint: { 'fill-color': '#1B6A5C', 'fill-opacity': 0.22 } });
      MAP.addLayer({ id: 'dwr-line', type: 'line', source: 'dwr', paint: { 'line-color': '#1B6A5C', 'line-width': 1.2 } });
      MAP.addLayer({ id: 'dwr-name', type: 'symbol', source: 'dwr', minzoom: 10, layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-size': 11, 'text-max-width': 8 }, paint: { 'text-color': '#0F4A40', 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });
    }
    if (wia) {
      MAP.addSource('wia', { type: 'geojson', data: wia });
      MAP.addLayer({ id: 'wia-fill', type: 'fill', source: 'wia', paint: { 'fill-color': '#B7791F', 'fill-opacity': 0.25 } });
      MAP.addLayer({ id: 'wia-line', type: 'line', source: 'wia', paint: { 'line-color': '#B7791F', 'line-width': 1.2, 'line-dasharray': [2, 1] } });
    }
    if (ug && ug.units) {
      UNITS = UNITS || ug.units;
      MAP.addSource('units', { type: 'geojson', data: { type: 'FeatureCollection', features: ug.units.map(u => ({ type: 'Feature', properties: { n: u.n }, geometry: { type: 'MultiPolygon', coordinates: u.p } })) } });
      MAP.addLayer({ id: 'units-line', type: 'line', source: 'units', paint: { 'line-color': '#7A1F5C', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 1.8], 'line-opacity': 0.7 } });
    }
    MAP.addSource('pts', { type: 'geojson', data: { type: 'FeatureCollection', features: DB.birds.map(p => ({ type: 'Feature', properties: { id: p.id, name: p.name, sp: String(p.species || '').split(/[\/,; ]+/)[0] }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })) } });
    MAP.addLayer({ id: 'pts', type: 'circle', source: 'pts', paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 4, 12, 8], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
      'circle-color': ['match', ['get', 'sp'], 'duck', SPC.duck, 'pheasant', SPC.pheasant, 'chukar', SPC.chukar, 'ptarmigan', SPC.ptarmigan, '#333'] } });
    MAP.addLayer({ id: 'pts-name', type: 'symbol', source: 'pts', minzoom: 9.5, layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-max-width': 9 }, paint: { 'text-color': '#1c1c1c', 'text-halo-color': '#fff', 'text-halo-width': 1.4 } });
    MAP.on('click', 'pts', e => { const p = DB.birds.find(x => x.id === e.features[0].properties.id); if (p) { openSheet(sheetPoint(p)); loadWx(p.lat, p.lon); } });
    MAP.on('click', e => {
      if (MAP.queryRenderedFeatures(e.point, { layers: ['pts'] }).length) return;
      const hit = MAP.queryRenderedFeatures(e.point, { layers: ['dwr-fill', 'wia-fill'].filter(id => MAP.getLayer(id)) })[0];
      const un = UNITS ? unitsAt(e.lngLat.lng, e.lngLat.lat).map(u => esc(u.n)) : [];
      const lf = landOn ? MAP.queryRenderedFeatures(e.point, { layers: ['land-fill', 'land-private'].filter(id => MAP.getLayer(id)) })[0] : null;
      const lc = lf ? LAND.find(l => l[0] === lf.properties.c) : null;
      const rd = roadsOn ? MAP.queryRenderedFeatures([[e.point.x - 9, e.point.y - 9], [e.point.x + 9, e.point.y + 9]], { layers: ROAD_LINES.filter(id => MAP.getLayer(id)) })[0] : null;
      const ar = roadsOn && MAP.getLayer('blm-areas') ? MAP.queryRenderedFeatures(e.point, { layers: ['blm-closed', 'blm-areas'] })[0] : null;
      if (!hit && !un.length && !lc && !rd && !ar) return;
      const pr = hit ? hit.properties : {};
      const nm = pr.name || pr['UDWR.DWRADMIN.WIA_Properties.Name'] || '';
      let rdHtml = '';
      if (rd) {
        const q = rd.properties, stt = mvStatus(q), blm = q.src === 'blm';
        const head = blm ? `<b>BLM ${q.k === 't' ? 'trail' : 'route'}${q.n ? ' &middot; ' + esc(q.n) : ''}</b>${q.id ? ' <span class="mono" style="font-size:10.5px">' + esc(q.id) + '</span>' : ''}`
          : `<b>${q.k === 't' ? 'Trail' : 'Forest Road'} ${esc(q.id || '')}</b>${q.n && q.n !== 'Un-Named' ? ' &middot; ' + esc(q.n) : ''}`;
        const body = blm ? `${esc(q.why || '')}${q.cl ? '<br>' + esc(q.cl) : ''}${q.sf ? ' &middot; ' + esc(q.sf) + ' surface' : ''}<br><i>BLM lists no seasonal dates here. Wet-weather, fire and wildlife closures are posted on the ground.</i>`
          : `${esc(q.v || '').split(' | ').join('<br>')}${q.sf ? '<br>Surface: ' + esc(q.sf) : ''}${q.ml ? '<br>Maintained for: ' + esc(q.ml) : ''}<br>${esc(q.fo || '')} NF${q.dn ? ', ' + esc(q.dn) + ' district' : ''}`;
        rdHtml = `${head}<br><span class="own"><i style="background:${MV[stt.k]}"></i><b>${esc(stt.txt)}</b></span><br><span style="font-size:11.5px">${body}</span><hr class="pophr">`;
      }
      if (ar) {
        const d = ar.properties.d, rule = { Open: 'Open: cross-country travel allowed', Limited: 'Limited: stay on designated or existing routes', Closed: 'CLOSED to motor vehicles' }[d] || d;
        rdHtml += `<span style="font-size:11.5px"><b>BLM travel rule here:</b> ${esc(rule)}${ar.properties.a ? ' (' + esc(ar.properties.a) + ')' : ''}${!rd && d === 'Limited' ? '<br><i>No BLM route drawn here. BLM has published routes for southern and eastern Utah but almost none for the West Desert and Box Elder; the area rule still applies.</i>' : ''}</span><hr class="pophr">`;
      }
      const acId = hit && (hit.layer.id === 'wia-fill'
        ? 'wia:' + String(pr[Object.keys(pr).find(k => k.endsWith('WIA_Properties.PropertyID'))] || '').replace(/[{}]/g, '').toLowerCase()
        : 'dwr:' + pr.id);
      const ac = acId && typeof acFor === 'function' ? acFor(acId) : null;
      new maplibregl.Popup({ maxWidth: '270px' }).setLngLat(e.lngLat).setHTML(rdHtml +
        (nm ? `<b>${esc(nm)}</b><br>${hit.layer.id === 'wia-fill' ? 'Walk-In Access property' : esc(pr.type_ || 'DWR property')}<br>` : '') +
        (ac ? acBlock(ac) : '') +
        (lc ? `<span class="own"><i style="background:${lc[2]}"></i><b>${esc(lc[1])}</b>${lf.properties.name ? ' &middot; ' + esc(lf.properties.name) : ''}</span>${LAND_NOTE[lc[0]] ? `<br><span style="font-size:11.5px">${LAND_NOTE[lc[0]]}</span>` : ''}<br>` : '') +
        (un.length ? `<span class="mono" style="font-size:11px">Hunt units: ${un.join(' &middot; ')}</span>` : '')).addTo(MAP);
    });
    MAP.on('mouseenter', 'pts', () => { MAP.getCanvas().style.cursor = 'pointer'; });
    MAP.on('mouseleave', 'pts', () => { MAP.getCanvas().style.cursor = ''; });
  });
  drawLegend();
  refreshMapBar();
}

/* ---------------------------------------------------------------- views --- */
function vToday() {
  const up = upcoming(), on = openNow();
  const next = up[0];
  let h = '';
  if (next) {
    const n = next.st.n;
    h += `<div class="hero">
      <div class="lab">Next deadline</div>
      <div class="big">${n === 0 ? 'Today' : n + ' day' + (n === 1 ? '' : 's')}</div>
      <div class="sub">${esc(next.d.title)} &middot; ${fmt(d0(next.d.date))}</div></div>`;
  }
  h += `<div class="acts" style="padding:12px 0 0"><button class="btn ghost" data-where="1">Where am I &middot; hunt unit from GPS</button><button class="btn ghost" data-gofind="1">Find a hunt</button></div>`;
  h += (typeof cardTrip === 'function' ? cardTrip() : '');
  h += cardLight();
  h += `<div class="sec-title">Open right now</div><div class="card">`;
  h += on.length ? on.map(x => `<button class="row" data-season="${esc(x.s.id)}" style="--g:${GC[x.s.group] || 'var(--accent)'}">
      <span class="pill"></span>
      <span><span class="t">${esc(x.s.name)}</span><span class="s">${esc(x.s.bag || x.s.area || '')}</span></span>
      <span class="v">${x.st.n}<small>days left</small></span></button>`).join('')
    : '<p class="empty">Nothing open today.</p>';
  h += `</div>`;

  h += `<div class="sec-title">Closest access from ${esc(hlabel())}</div><div class="card">`;
  const near = DB.birds.slice().sort((a, b) => drive(a).mins - drive(b).mins).slice(0, 5);
  h += near.map(p => rowPoint(p)).join('') || '<p class="empty">No access data.</p>';
  h += `</div>`;

  h += (typeof cardFish === 'function' ? cardFish() : '');
  h += cardLake();
  h += cardSnow();
  h += `<div class="sec-title">What is coming</div><div class="card">`;
  h += up.slice(0, 6).map(x => `<button class="row" data-dl="${esc(x.d.id)}" style="--g:var(--accent)">
      <span class="pill"></span>
      <span><span class="t">${esc(x.d.title)}</span>
      <span class="s">${fmt(d0(x.d.date))}${x.d.projected ? ' &middot; projected' : ''}</span></span>
      <span class="v"><span class="state ${x.st.k}">${x.st.n}d</span></span></button>`).join('');
  h += `</div>`;
  return h;
}

function rowPoint(p) {
  const d = drive(p);
  const grp = p.species && /ptarmigan|duck|chukar|pheasant|quail|partridge/i.test(p.species) ? 'bird' : 'bird';
  return `<button class="row" data-pt="${esc(p.id)}" style="--g:${GC[grp]}">
    <span class="pill"></span>
    <span><span class="t">${esc(p.name)}</span>
    <span class="s">${esc(p.county)} Co. &middot; ${esc(p.species)}</span></span>
    <span class="v">${d.txt}<small>${d.sub}</small></span></button>`;
}

function vAccess() {
  const cats = [...new Set(DB.birds.map(p => p.species))].sort();
  let h = `<input class="search" id="q" placeholder="Search access by name or county" value="${esc(query)}">`;
  h += `<div class="chips">` + cats.map(c =>
    `<button class="chip" data-sp="${esc(c)}" aria-pressed="${speciesFilter.has(c)}" style="--g:var(--bird)"><i></i>${esc(c)}</button>`
  ).join('') + `</div>`;
  let list = DB.birds.filter(p => {
    if (speciesFilter.size && !speciesFilter.has(p.species)) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return (p.name + ' ' + p.county + ' ' + p.species + ' ' + p.access_type).toLowerCase().includes(q);
  }).sort((a, b) => drive(a).mins - drive(b).mins);
  h += `<div class="card"><div class="card-h"><h2>${list.length} places</h2>
    <span class="r">by drive from ${esc(hlabel())}</span></div>`;
  h += list.length ? list.map(rowPoint).join('') : '<p class="empty">Nothing matches.</p>';
  h += `</div><p class="note" style="padding:12px 2px">* A range means the point is a property centroid out in the
    marsh, so routing runs the last miles down dike roads and overstates the drive. Use the low number.</p>`;
  return h;
}

/* ------------------------------------------------------------ draw odds ---- */
/* UDWR's published draw results, parsed by scraper/build_odds.py. These are LAST
   YEAR'S RESULTS at each point level, not a forecast. Points the hunter types in
   stay on the phone (localStorage) and are never sent anywhere. */
let ODDS = null, oddsLoading = false, seasonsMode = 'dates';
const DRAW_GROUPS = [['Limited entry and once-in-a-lifetime', 'Limited entry'], ['General-season buck deer', 'General deer'], ['Antlerless', 'Antlerless']];
let draw = { res: 'r', grp: DRAW_GROUPS[0][0], sp: 'Elk', pts: {} };
try { Object.assign(draw, JSON.parse(localStorage.getItem('ha.draw') || '{}')); } catch (e) { /* private mode */ }
const saveDraw = () => { try { localStorage.setItem('ha.draw', JSON.stringify(draw)); } catch (e) { /* private mode */ } };
const ptsKey = () => draw.grp + '|' + draw.sp;
const myPts = () => draw.pts[ptsKey()] || 0;
function loadOdds() {
  if (ODDS || oddsLoading) return;
  oddsLoading = true;
  fetch('data/draw_odds.json').then(r => r.json()).then(j => { ODDS = j && j.years ? j : null; })
    .catch(() => { ODDS = null; }).finally(() => { oddsLoading = false; if (tab === 'seasons') render(); });
}
function oddsAt(h, pts) {
  const rows = h[draw.res] || [];
  if (!rows.length) return { k: 'none', txt: 'No applicants', sort: -1 };
  const top = Math.max(...rows.map(r => r[0]));
  const row = rows.find(r => r[0] === pts);
  if (!row) return pts > top ? { k: 'top', txt: 'Top of the pool', sort: 2 } : { k: 'none', txt: 'None at ' + pts + ' pts', sort: -1 };
  const apps = row[1], got = row[2] + row[3];
  if (!got) return { k: 'zero', txt: '0 of ' + apps + ' drew', sort: 0, apps, got };
  if (got >= apps) return { k: 'all', txt: 'All ' + apps + ' drew', sort: 1.5, apps, got };
  return { k: 'some', txt: '1 in ' + (apps / got).toFixed(1), pct: Math.round(got / apps * 100), sort: got / apps, apps, got };
}
function sureAt(h) {                       // lowest point level from which everyone who applied drew
  const rows = (h[draw.res] || []).filter(r => r[1] > 0).sort((a, b) => b[0] - a[0]);
  let sure = null;
  for (const r of rows) { if (r[2] + r[3] >= r[1]) sure = r[0]; else break; }
  return sure;
}
function vDraw() {
  if (!ODDS) { loadOdds(); return `<p class="empty">${oddsLoading ? 'Loading draw results&hellip;' : 'Draw results are not on this phone yet. Open this once with a signal.'}</p>`; }
  const yr = Object.keys(ODDS.years).sort().pop(), all = ODDS.years[yr];
  const inGrp = Object.entries(all).filter(([, h]) => h.g === draw.grp);
  const species = [...new Set(inGrp.map(([, h]) => h.s))].sort();
  if (!species.includes(draw.sp)) draw.sp = species[0];
  const kind = (inGrp.find(([, h]) => h.s === draw.sp) || [0, { k: 'b' }])[1].k === 'p' ? 'preference' : 'bonus';
  const pts = myPts(), ql = query.trim().toLowerCase();
  const list = inGrp.filter(([c, h]) => h.s === draw.sp && (!ql || (c + ' ' + h.n).toLowerCase().includes(ql)))
    .map(([c, h]) => ({ c, h, o: oddsAt(h, pts), permits: (h[draw.res] || []).reduce((t, r) => t + r[2] + r[3], 0) }))
    .sort((a, b) => b.o.sort - a.o.sort || b.permits - a.permits);
  let h = `<div class="seg" style="margin-top:12px">${DRAW_GROUPS.map(g => `<button data-dgrp="${esc(g[0])}" aria-pressed="${draw.grp === g[0]}">${g[1]}</button>`).join('')}</div>
    <div class="chipsrow">${species.map(sp => `<button class="chip" data-dsp="${esc(sp)}" aria-pressed="${draw.sp === sp}">${esc(sp)}</button>`).join('')}</div>
    <div class="drawctl">
      <div class="seg small"><button data-dres="r" aria-pressed="${draw.res === 'r'}">Resident</button><button data-dres="x" aria-pressed="${draw.res === 'x'}">Nonresident</button></div>
      <div class="stepper"><button data-dpts="-1" aria-label="Fewer points">&minus;</button><span><b>${pts}</b> ${kind} point${pts === 1 ? '' : 's'}</span><button data-dpts="1" aria-label="More points">+</button></div>
    </div>
    <input class="search" id="q" placeholder="Search ${esc(draw.sp.toLowerCase())} hunts by unit, weapon or hunt code" value="${esc(query)}">
    <div class="sec-title">${yr} results at ${pts} point${pts === 1 ? '' : 's'} &middot; ${list.length} hunt${list.length === 1 ? '' : 's'}</div><div class="card">`;
  h += list.slice(0, 80).map(x => `<button class="row" data-draw="${esc(x.c)}" style="--g:${{ all: 'var(--brand)', top: 'var(--brand)', some: 'var(--accent)', zero: 'var(--crit)', none: 'var(--faint)' }[x.o.k]}">
      <span class="pill"></span>
      <span><span class="t">${esc(x.h.n)}</span><span class="s mono">${esc(x.c)} &middot; ${x.permits} permit${x.permits === 1 ? '' : 's'} to ${draw.res === 'r' ? 'residents' : 'nonresidents'}</span></span>
      <span class="v dv">${esc(x.o.txt)}${x.o.pct != null ? `<small>${x.o.pct}%</small>` : ''}</span></button>`).join('') || '<p class="empty">No hunts match.</p>';
  h += `</div>${list.length > 80 ? '<p class="fine">Showing the best 80. Search to narrow it.</p>' : ''}
    <p class="fine"><b>Top of the pool</b> means nobody who applied last year had as many points as you. <b>None at N pts</b> means nobody applied with exactly your points.</p>
    <p class="fine">These are UDWR's published <b>${yr} results</b>, not a forecast: what happened to people who applied with your number of points.
    More people gain points every year, so the same points usually buy a little less next time. Your points are kept on this phone only.
    Source: wildlife.utah.gov/biggame/odds. Always confirm at utahdraws.com before applying.</p>`;
  return h;
}
function sheetDraw(code) {
  const years = Object.keys(ODDS.years).sort().reverse(), yr = years[0], h = ODDS.years[yr][code];
  if (!h) return '';
  const pts = draw.pts[h.g + '|' + h.s] || 0, rows = (h[draw.res] || []).slice().sort((a, b) => b[0] - a[0]);
  const tot = rows.reduce((t, r) => [t[0] + r[1], t[1] + r[2], t[2] + r[3]], [0, 0, 0]), sure = sureAt(h);
  const prev = years[1] && ODDS.years[years[1]][code], po = prev ? oddsAt(prev, pts) : null, o = oddsAt(h, pts);
  const bonus = h.k === 'b';
  return `<h3>${esc(h.n)}</h3><p class="where mono">${esc(code)} &middot; ${esc(h.g)} &middot; ${draw.res === 'r' ? 'residents' : 'nonresidents'}</p>
    <div class="stats">
      <div class="stat"><div class="k">You, ${pts} pt${pts === 1 ? '' : 's'} (${yr})</div><div class="v" style="font-size:13px">${esc(o.txt)}</div></div>
      ${po ? `<div class="stat"><div class="k">Same points, ${years[1]}</div><div class="v" style="font-size:13px">${esc(po.txt)}</div></div>` : ''}
      <div class="stat"><div class="k">Everyone drew at</div><div class="v" style="font-size:13px">${sure == null ? 'no level' : sure + '+ pts'}</div></div>
      <div class="stat"><div class="k">Permits / applicants</div><div class="v" style="font-size:13px">${tot[1] + tot[2]} / ${tot[0]}</div></div>
    </div>
    <table class="odds"><tr><th>Points</th><th>Applied</th><th>${bonus ? 'Bonus' : 'Drew'}</th>${bonus ? '<th>Random</th>' : ''}<th>Odds</th></tr>
    ${rows.map(r => { const g = r[2] + r[3]; return `<tr${r[0] === pts ? ' class="me"' : ''}><td>${r[0]}</td><td>${r[1]}</td><td>${bonus ? r[2] : g}</td>${bonus ? `<td>${r[3]}</td>` : ''}<td>${!g ? '&mdash;' : g >= r[1] ? 'all' : '1 in ' + (r[1] / g).toFixed(1)}</td></tr>`; }).join('')}</table>
    <p class="fine" style="padding:10px 16px">${bonus
      ? 'Bonus-point hunt. Half the permits go straight to the applicants with the most points (the Bonus column). The other half are drawn at random, with one extra chance per point (the Random column), so anyone can draw.'
      : 'Preference-point hunt. Permits go to the applicants with the most points first, so below the cut-off line the odds are effectively zero and above it everyone draws.'}
    Last year&rsquo;s results, not a forecast. Point levels nobody applied at are left out.</p>`;
}

function vSeasons() {
  const groups = ['bird', 'smallgame', 'deer', 'elk', 'turkey'];
  let h = `<div class="seg" style="margin-top:14px"><button data-smode="dates" aria-pressed="${seasonsMode === 'dates'}">Season dates</button><button data-smode="draw" aria-pressed="${seasonsMode === 'draw'}">Draw odds</button><button data-smode="find" aria-pressed="${seasonsMode === 'find'}">Find a hunt</button></div>`;
  if (seasonsMode === 'draw') return h + vDraw();
  if (seasonsMode === 'find') return h + (typeof vFind === 'function' ? vFind() : '');
  for (const g of groups) {
    const rows = (DB.seasons.seasons || []).filter(s => s.group === g)
      .map(s => ({ s, st: seasonState(s) }))
      .sort((a, b) => d0(a.s.start) - d0(b.s.start));
    if (!rows.length) continue;
    h += `<div class="sec-title">${{ bird: 'Birds', smallgame: 'Small game', deer: 'Deer', elk: 'Elk', turkey: 'Turkey' }[g]}</div><div class="card">`;
    h += rows.map(x => `<button class="row" data-season="${esc(x.s.id)}" style="--g:${GC[g]}">
      <span class="pill"></span>
      <span><span class="t">${esc(x.s.name)}</span>
      <span class="s">${fmt(d0(x.s.start))} &ndash; ${fmt(d0(x.s.end))}</span></span>
      <span class="v"><span class="state ${x.st.k}">${x.st.k === 'open' ? 'open' : x.st.k === 'soon' ? x.st.n + 'd' : '&mdash;'}</span></span></button>`).join('');
    h += `</div>`;
  }
  return h;
}

function vReminders() {
  const up = upcoming();
  const icsUrl = new URL('hunt.ics', location.href).href;
  const webcal = icsUrl.replace(/^https?:/, 'webcal:');
  let h = `<div class="card"><div class="card-h"><h2>Put these on your phone</h2></div><div class="card-b">
    <p class="note">Subscribe once and every season, deadline and landowner call lands in your normal
    calendar with alerts. It refreshes itself twice a day. Nothing to open, nothing to allow.</p>
    <div class="acts" style="padding:14px 0 0">
      <a class="btn" href="${esc(webcal)}">Subscribe in Calendar</a>
      <a class="btn ghost" href="${esc(icsUrl)}">Download .ics</a></div>
    <p class="note" style="margin-top:12px">If the button does nothing: iPhone Settings &rarr; Apps &rarr;
    Calendar &rarr; Calendar Accounts &rarr; Add Account &rarr; Other &rarr; Add Subscribed Calendar,
    and paste<br><span class="mono" style="font-size:11px;word-break:break-all">${esc(icsUrl)}</span></p>
  </div></div>`;

  h += `<div class="sec-title">Every deadline</div><div class="card">`;
  h += up.map(x => `<button class="row" data-dl="${esc(x.d.id)}" style="--g:var(--accent)">
    <span class="pill"></span>
    <span><span class="t">${esc(x.d.title)}</span>
    <span class="s">${fmt(d0(x.d.date))}${x.d.projected ? ' &middot; projected' : ''}</span></span>
    <span class="v"><span class="state ${x.st.k}">${x.st.n}d</span></span></button>`).join('')
    || '<p class="empty">Nothing upcoming.</p>';
  h += `</div>`;

  const perms = (DB.config.permits || []);
  h += `<div class="sec-title">Permits and paperwork</div><div class="card">`;
  h += perms.map(p => `<button class="row" data-permit="${esc(p.id)}" style="--g:${p.new ? 'var(--warn)' : 'var(--accent)'}">
    <span class="pill"></span>
    <span><span class="t">${esc(p.name)}${p.new ? ' &middot; NEW' : ''}</span>
    <span class="s">${esc(p.needed_for)}</span></span>
    <span class="v">${esc(p.cost)}</span></button>`).join('');
  h += `</div>`;
  return h;
}

/* ------------------------------------------------------- landowner tags ---- */
function vTags() {
  if (!LOT) { fetch('data/landowner_tags.json').then(r => r.json()).then(j => { LOT = j; if (tab === 'contacts') render(); }).catch(() => { LOT = { states: [] }; }); return '<p class="empty">Loading&hellip;</p>'; }
  const S = LOT.states || [], s = S.find(x => x.st === lotState) || S[0];
  if (!s) return '';
  const badge = { yes: ['Can be sold', 'var(--brand)'], direct: ['Sold direct only', 'var(--warn)'], no: ['Not for sale', 'var(--crit)'], silent: ['Rule is silent', 'var(--muted)'] }[s.sell] || ['', 'var(--muted)'];
  return `<div class="chipsrow" style="margin-top:12px">${S.map(x => `<button class="chip" data-lot="${x.st}" aria-pressed="${x.st === s.st}">${x.st}</button>`).join('')}</div>
    <div class="sec-title">${esc(s.name)} &middot; landowner tags</div><div class="card">
      <div class="stats"><div class="stat" style="grid-column:span 2"><div class="k">Sale to a hunter</div><div class="v" style="font-size:13px;color:${badge[1]}">${badge[0]}</div></div>
        <div class="stat"><div class="k">Confidence</div><div class="v" style="font-size:12px">${esc(s.confidence)}</div></div></div>
      <dl class="f"><dt>Program</dt><dd>${esc(s.program)}</dd><dt>Selling</dt><dd>${esc(s.sell_plain)}</dd><dt>Brokers</dt><dd>${esc(s.broker)}</dd>
        <dt>Prices seen</dt><dd>${esc(s.price)}</dd><dt>Depredation / damage permits</dt><dd>${esc(s.depredation)}</dd><dt>Public access to private land</dt><dd>${esc(s.access)}</dd>
        <dt>Source</dt><dd>${esc(s.cite)}</dd><dt>Recent changes</dt><dd>${esc(s.changed)}</dd></dl></div>
    <div class="warnbox" style="margin-top:12px">${esc(LOT.outfitter_note || '')}</div>
    <p class="fine" style="padding-left:2px">Researched 2026-09-21 from state statutes, rules and agency pages; 'high' means the state's own text was read, 'medium' means a legal-code mirror or consistent reporting. Not legal advice. Rules change every year.</p>`;
}
function vContacts() {
  let h = `<div class="sec-title">Calls that are still open questions</div><div class="card">`;
  h += (DB.config.contacts || []).map(c => `<button class="row" data-contact="${esc(c.name)}" style="--g:${c.priority === 'high' ? 'var(--crit)' : 'var(--accent)'}">
    <span class="pill"></span>
    <span><span class="t">${esc(c.name)}</span><span class="s">${esc(c.why)}</span></span>
    <span class="v">${esc(c.phone)}</span></button>`).join('');
  h += `</div>`;

  h += `<div class="sec-title">Walk-In Access &mdash; landowner contact required</div><div class="card">`;
  if (typeof acList === 'function' && acList().length > 0) h += acList().map(entry => `<button class="row" data-ac="${esc(entry.ids[0])}" style="--g:var(--warn)"><span class="pill"></span>
    <span><span class="t">${esc(entry.name)}</span><span class="s">${esc(entry.county)} Co. &middot; ${esc(entry.program)}</span></span>
    <span class="v">call<small>first</small></span></button>`).join('');
  else h += (DB.config.wia_landowner_calls || []).map((w, i) => `<button class="row" data-wia="${i}" style="--g:var(--warn)">
    <span class="pill"></span>
    <span><span class="t">${esc(w.property)}</span><span class="s">${esc(w.county)} Co. &middot; ${w.acres} ac</span></span>
    <span class="v">call<small>first</small></span></button>`).join('');
  h += `</div>`;

  const L = DB.config.legal || {};
  h += `<div class="sec-title">Before you knock on a door</div><div class="card"><div class="card-b">
    <p class="note"><strong>${esc(L.written_permission || '')}</strong></p>
    <div class="warnbox"><strong>Cultivated</strong> ${esc(L.cultivated || '')}<br><br>
    <strong>Posted</strong> ${esc(L.posted || '')}<br><br>
    <strong>Penalty</strong> ${esc(L.penalty || '')}</div>
    <p class="note" style="margin-top:10px">${esc(L.citation || '')}</p></div></div>`;

  if (DB.community) {
    const items = (DB.community.items || []).slice(0, 12);
    h += `<div class="sec-title">Community chatter</div><div class="card">`;
    h += items.length ? items.map(it => `<a class="row" href="${esc(it.url)}" target="_blank" rel="noopener" style="--g:var(--muted);text-decoration:none">
      <span class="pill"></span>
      <span><span class="t">${esc(it.title)}</span><span class="s">${esc(it.source)}</span></span>
      <span class="v">&rsaquo;</span></a>`).join('') : '<p class="empty">Nothing collected yet.</p>';
    h += `</div>`;
    h += `<div class="sec-title">Check these yourself</div><div class="card">`;
    h += (DB.community.manual_watch || []).map(m => `<a class="row" href="${esc(m.url)}" target="_blank" rel="noopener" style="--g:var(--muted);text-decoration:none">
      <span class="pill"></span><span><span class="t">${esc(m.name)}</span></span><span class="v">&rsaquo;</span></a>`).join('');
    h += `</div><p class="note" style="padding:12px 2px">${esc(DB.community.policy || '')}</p>`;
  }
  h += `<div class="sec-title" style="margin-top:26px">Landowner tags, state by state</div>` + vTags();
  return h;
}

/* ---------------------------------------------------------------- sheet --- */
function openSheet(html) {
  $('sheetin').innerHTML = '<div class="grab"></div>' + html;
  $('sheet').hidden = false;
  $('sheetin').scrollTop = 0;
}
function closeSheet() { $('sheet').hidden = true; }

function sheetPoint(p) {
  const d = (p.drive || {});
  const st = k => { const x = d[k]; if (!x) return '--'; return x.range ? x.range[0] + '-' + x.range[1] : x.min; };
  const f = (t, v) => v ? `<dt>${t}</dt><dd>${esc(v)}</dd>` : '';
  const link = /^https?:\/\//i.test((p.contact || '').trim())
    ? `<a href="${esc(p.contact.trim())}" target="_blank" rel="noopener">${esc(p.contact.trim())}</a>`
    : esc(p.contact || '');
  return `<h3>${esc(p.name)}</h3>
    <p class="where">${esc(p.county)} County &middot; ${esc(p.access_type.replace(/_/g, ' '))}</p>
    <div class="stats">
      <div class="stat"><div class="k">N Salt Lake</div><div class="v">${st('nsl')}m</div></div>
      <div class="stat"><div class="k">Heber</div><div class="v">${st('heber')}m</div></div>
      <div class="stat"><div class="k">Torrey</div><div class="v">${st('torrey')}m</div></div>
      <div class="stat"><div class="k">Confidence</div><div class="v" style="font-size:12px">${esc(p.confidence)}</div></div>
    </div>
    <div class="acts">
      <a class="btn" href="https://maps.apple.com/?daddr=${p.lat},${p.lon}&dirflg=d">Directions</a>
      <button class="btn ghost" data-copy="${p.lat}, ${p.lon}">Copy coordinates</button>
    </div>
    ${typeof roadSlot === 'function' ? roadSlot(p) : ''}
    <dl class="f">
      ${f('Season', p.season)}${f('Releases', p.stocking)}${f('Restrictions', p.restrictions)}
      ${f('Permits', p.permits)}${f('Managed by', p.agency)}
      ${link ? `<dt>Contact</dt><dd>${link}</dd>` : ''}
      ${f('Notes', p.notes)}
      <div id="wx" style="display:contents"><dt>Forecast</dt><dd>Loading&hellip;</dd></div>
      <dt>Source</dt><dd>${esc(p.source_url)} &middot; retrieved ${esc(p.source_date)}</dd>
    </dl>`;
}
function sheetSeason(s) {
  const st = seasonState(s);
  return `<h3>${esc(s.name)}</h3>
    <p class="where">${fmt(d0(s.start))} &ndash; ${fmt(d0(s.end))} &middot;
      <span class="state ${st.k}">${esc(st.label)}</span></p>
    <dl class="f">
      ${s.bag ? `<dt>Limit</dt><dd>${esc(s.bag)}</dd>` : ''}
      ${s.area ? `<dt>Area open</dt><dd>${esc(s.area)}</dd>` : ''}
      ${s.permit ? `<dt>Needs</dt><dd>${esc(s.permit)}</dd>` : ''}
      ${s.note ? `<dt>Note</dt><dd>${esc(s.note)}</dd>` : ''}
      <dt>Source</dt><dd>${esc(DB.seasons._source)}</dd>
    </dl>`;
}
function sheetDeadline(d) {
  const st = deadlineState(d);
  return `<h3>${esc(d.title)}</h3>
    <p class="where">${fmt(d0(d.date))} &middot; <span class="state ${st.k}">${st.n} days</span></p>
    ${d.projected ? '<div class="warnbox" style="margin:12px 16px 0">Projected date, not yet confirmed by UDWR. The refresh job watches for the official announcement.</div>' : ''}
    <dl class="f"><dt>Detail</dt><dd>${esc(d.detail)}</dd></dl>`;
}

/* --------------------------------------------------------------- render --- */
const TABS = [
  ['today', 'Today', '<path d="M3 10h18M7 3v4M17 3v4"/><rect x="3" y="5" width="18" height="16" rx="2"/>'],
  ['map', 'Map', '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>'],
  ['access', 'Access', '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>'],
  ['fish', 'Fish', '<path d="M3 12c3-4.5 7-6 11-6 3 0 5.5 2.5 7 6-1.500 3.500-4 6-7 6-4 0-8-1.500-11-6z"/><path d="M3 7.500v9"/><circle cx="16" cy="11" r=".9"/>'],
  ['cams', 'Cams', '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.2"/>'],
  ['seasons', 'Seasons', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
  ['remind', 'Remind', '<path d="M18 8a6 6 0 1 0-12 0c0 7-2 8-2 8h16s-2-1-2-8"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/>'],
  ['contacts', 'Contacts', '<path d="M4 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4z"/><circle cx="11" cy="11" r="2.5"/><path d="M7.5 17c.8-1.7 2-2.5 3.5-2.5s2.7.8 3.5 2.5"/>']
];
function hlabel() {
  const h = (DB.config.homes || []).find(x => x.id === home);
  return h ? h.label : home;
}
function renderChrome() {
  $('homesel').innerHTML = (DB.config.homes || []).map(h =>
    `<button data-home="${esc(h.id)}" aria-pressed="${h.id === home}">${esc(h.label.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase())}</button>`
  ).join('');
  const n = alerts();
  $('tabs').innerHTML = TABS.map(([k, label, path]) =>
    `<button data-tab="${k}"${tab === k ? ' aria-current="page"' : ''}>
      <span style="position:relative"><svg viewBox="0 0 24 24">${path}</svg>${k === 'remind' && n ? `<span class="badge">${n}</span>` : ''}</span>
      <span>${label}</span></button>`).join('');
  const ttl = { today: 'Today', map: 'Map', cams: 'Trail cameras', access: 'Access', fish: 'Fishing', seasons: 'Seasons', remind: 'Reminders', contacts: 'Contacts' }[tab];
  if (tab === 'today') $('title').innerHTML = '<img src="icons/rangerhawk-wordmark.svg" alt="Ranger Hawk">'; else $('title').textContent = ttl;
}
function render() {
  renderChrome();
  if (MAP && tab !== 'map') { try { MAP.remove(); } catch (e) { /* already gone */ } MAP = null; }
  if (tab === 'map' && MAP) { renderChrome(); return; }
  const v = { today: vToday, map: vMap, cams: (typeof vCams === 'function' ? vCams : () => '<p class="empty">Camera log did not load.</p>'), access: vAccess, fish: (typeof vFish === 'function' ? vFish : () => '<p class="empty">Fishing did not load.</p>'), seasons: vSeasons, remind: vReminders, contacts: vContacts }[tab];
  $('view').innerHTML = v();
  document.body.classList.toggle('on-map', tab === 'map');
  if (tab === 'map') initMap();
  const q = $('q');
  if (q) {
    q.addEventListener('input', e => { query = e.target.value; const s = e.target.selectionStart; render(); const n = $('q'); if (n) { n.focus(); n.setSelectionRange(s, s); } });
  }
}

/* --------------------------------------------------------------- events --- */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-tab],[data-home],[data-pt],[data-season],[data-dl],[data-sp],[data-permit],[data-contact],[data-wia],[data-copy],[data-where],[data-mapsave],[data-landtoggle],[data-roadstoggle],[data-veh],[data-keytoggle],[data-terraintoggle],[data-lot],[data-gofind],[data-smode],[data-dgrp],[data-dsp],[data-dres],[data-dpts],[data-draw]');
  if (!t) { if (e.target.id === 'sheet') closeSheet(); return; }
  if (t.dataset.tab) { tab = t.dataset.tab; query = ''; render(); window.scrollTo(0, 0); return; }
  if (t.dataset.home) { home = t.dataset.home; try { localStorage.setItem('ha.home', home); } catch (x) {} render(); return; }
  if (t.dataset.sp) { const s = t.dataset.sp; speciesFilter.has(s) ? speciesFilter.delete(s) : speciesFilter.add(s); render(); return; }
  if (t.dataset.lot) { lotState = t.dataset.lot; render(); return; }
  if (t.dataset.gofind) { tab = 'seasons'; seasonsMode = 'find'; render(); window.scrollTo(0, 0); setTimeout(() => { const i = $('findq'); if (i) i.focus(); }, 50); return; }
  if (t.dataset.smode) { seasonsMode = t.dataset.smode; query = ''; render(); return; }
  if (t.dataset.dgrp) { draw.grp = t.dataset.dgrp; query = ''; saveDraw(); render(); return; }
  if (t.dataset.dsp) { draw.sp = t.dataset.dsp; saveDraw(); render(); return; }
  if (t.dataset.dres) { draw.res = t.dataset.dres; saveDraw(); render(); return; }
  if (t.dataset.dpts) { draw.pts[ptsKey()] = Math.max(0, Math.min(40, myPts() + (+t.dataset.dpts))); saveDraw(); render(); return; }
  if (t.dataset.draw) { openSheet(sheetDraw(t.dataset.draw)); return; }
  if (t.dataset.where) { whereAmI(); return; }
  if (t.dataset.mapsave) { saveMap(t.dataset.mapsave); return; }
  if (t.dataset.terraintoggle) { toggleTerrain(); return; }
  if (t.dataset.landtoggle) { toggleLand(); return; }
  if (t.dataset.roadstoggle) { toggleRoads(); return; }
  if (t.dataset.veh) { setVeh(t.dataset.veh); return; }
  if (t.dataset.keytoggle) { keyOn = !keyOn; t.setAttribute('aria-pressed', keyOn); drawLegend(); return; }
  if (t.dataset.pt) { const p = DB.birds.find(x => x.id === t.dataset.pt); if (p) { openSheet(sheetPoint(p)); loadWx(p.lat, p.lon); } return; }
  if (t.dataset.season) { const s = DB.seasons.seasons.find(x => x.id === t.dataset.season); if (s) openSheet(sheetSeason(s)); return; }
  if (t.dataset.dl) { const d = DB.seasons.deadlines.find(x => x.id === t.dataset.dl); if (d) openSheet(sheetDeadline(d)); return; }
  if (t.dataset.permit) {
    const p = DB.config.permits.find(x => x.id === t.dataset.permit);
    if (p) openSheet(`<h3>${esc(p.name)}</h3><p class="where">${esc(p.cost)}</p>
      <dl class="f"><dt>Needed for</dt><dd>${esc(p.needed_for)}</dd>
      <dt>Where</dt><dd>${esc(p.where)}</dd></dl>`);
    return;
  }
  if (t.dataset.contact) {
    const c = DB.config.contacts.find(x => x.name === t.dataset.contact);
    if (c) openSheet(`<h3>${esc(c.name)}</h3><p class="where">${esc(c.phone)}</p>
      <div class="acts"><a class="btn" href="tel:${esc(c.phone.replace(/[^0-9]/g, ''))}">Call</a></div>
      <dl class="f"><dt>Why</dt><dd>${esc(c.why)}</dd></dl>`);
    return;
  }
  if (t.dataset.wia) {
    const w = DB.config.wia_landowner_calls[+t.dataset.wia];
    if (w) openSheet(`<h3>${esc(w.property)}</h3>
      <p class="where">${esc(w.county)} County &middot; ${w.acres} acres</p>
      <div class="acts"><a class="btn" href="https://maps.apple.com/?daddr=${w.lat},${w.lon}&dirflg=d">Directions</a></div>
      <div class="warnbox" style="margin:14px 16px 0">${esc(w.requirement)}</div>
      <dl class="f"><dt>If denied access</dt><dd>${esc(w.contact || '')}</dd>
      <dt>Coordinates</dt><dd class="mono">${w.lat}, ${w.lon}</dd></dl>`);
    return;
  }
  if (t.dataset.copy) {
    const v = t.dataset.copy;
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject())
      .then(() => { t.textContent = 'Copied'; setTimeout(() => { t.textContent = 'Copy coordinates'; }, 1400); })
      .catch(() => { t.textContent = v; });
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

function net() { $('offline').hidden = navigator.onLine; }
window.addEventListener('online', net);
window.addEventListener('offline', net);

load().then(ok => {
  if (!ok) return;
  render(); net();
  import('./vendor/suncalc.js').then(m => { SUN = m; if (tab === 'today') render(); }).catch(() => { /* no legal-light card */ });
});
/* Register the worker, and when a new one takes over, reload once so the
   running page picks up the new shell instead of showing the old one until
   the app is force-quit. */
if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      if (reg.waiting) reg.waiting.postMessage('skip-waiting');
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            sw.postMessage('skip-waiting');
          }
        });
      });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => {});
  });
}
