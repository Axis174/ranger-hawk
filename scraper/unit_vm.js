/* Shared browser surface for the unit renderer and its app entry-point tests.
   No network is used. With serveFetches:false startup promises stay pending,
   and the synchronous page builder supplies only committed app data. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const tick = () => new Promise(resolve => setImmediate(resolve));

/* Every fetch waits until all of index.html's scripts have loaded. This catches
   a startup hook placed before units.js, or a loader that never opens its deep
   link when data arrive. Returned JSON is cloned, as a real fetch would be. */
function phone(search = '', opts = {}) {
  const DOCS = path.resolve(opts.docs || path.join(__dirname, '..', 'docs'));
  const INDEX = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  let searchReads = 0, searchValue = search, storageBlocked = false, mapEnabled = false;
  const storageCalls = [], fetched = [], pending = [], opened = [], listeners = {}, windowListeners = {}, timers = [];
  const store = new Map(Object.entries(opts.storage || { 'ha.draw': JSON.stringify({ res: 'x', pts: { 'Limited entry and once-in-a-lifetime|Elk': 37 } }) }));
  const element = id => {
    let html = '';
    return { id, hidden: id === 'sheet', style: {}, dataset: {}, textContent: '', scrollTop: 0,
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {}, addEventListener() {}, focus() {}, setSelectionRange() {}, querySelectorAll() { return []; },
      get innerHTML() { return html; }, set innerHTML(value) { html = String(value); if (id === 'sheetin') opened.push(html); } };
  };
  const elements = Object.fromEntries(['view', 'tabs', 'title', 'homesel', 'offline', 'sheet', 'sheetin', 'map', 'mapstate'].map(id => [id, element(id)]));
  const location = { href: 'https://rangerhawk.com/' + search, reload() {} };
  Object.defineProperty(location, 'search', { get() {
    /* Fishing owns a separate one-time parameter read at real app startup. */
    if (new Error().stack.includes('hUnitParam')) searchReads++;
    return searchValue;
  } });
  let currentTime = opts.now == null ? Date.parse('2026-10-15T18:00:00Z') : new Date(opts.now).getTime();
  class TestDate extends Date { constructor(...a) { super(...(a.length ? a : [currentTime])); } static now() { return currentTime; } }
  const box = {
    console, Date: TestDate, Math, JSON, Object, Array, String, Number, RegExp, Promise, Set, Map, Intl,
    URL, URLSearchParams, encodeURIComponent, decodeURIComponent, location,
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    setInterval() { return 0; }, clearInterval() {},
    document: { referrer: '', body: { classList: { toggle() {} } },
      getElementById(id) { return id === 'map' || id === 'mapstate' ? (mapEnabled ? elements[id] : null) : elements[id] || null; },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, querySelectorAll() { return []; },
      createElement() { return element('created'); }, head: { appendChild() {} } },
    window: { scrollTo() {}, addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); } },
    navigator: { onLine: false, geolocation: { getCurrentPosition(success) {
      const p = box.gps || { lat: 41.7, lon: -111.6 }; success({ coords: { latitude: p.lat, longitude: p.lon, accuracy: 8 } });
    } } },
    localStorage: Object.fromEntries(['getItem', 'setItem', 'removeItem'].map(method => [method, (key, value) => {
      storageCalls.push([method, key]); if (storageBlocked) throw new Error('unit renderer accessed localStorage');
      if (method === 'getItem') return store.get(key) || null;
      if (method === 'setItem') store.set(key, String(value)); else store.delete(key);
    }])),
    fetch(url) { fetched.push(String(url)); return new Promise((resolve, reject) => pending.push({ url: String(url), resolve, reject })); },
    Image: class { set src(v) {} }, gps: null,
  };
  vm.createContext(box);
  const scripts = opts.scripts || [...INDEX.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(m => m[1]);
  for (const file of scripts) {
    if (/^(?:https?:)?\/\//.test(file)) continue;
    const source = opts.sources && Object.hasOwn(opts.sources, file) ? opts.sources[file] : fs.readFileSync(path.join(DOCS, file), 'utf8');
    new vm.Script(source, { filename: file,
      importModuleDynamically: () => Promise.reject(new Error('SunCalc is outside the unit test')) }).runInContext(box);
  }
  vm.runInContext(`this.T = {
    sheetUnit, hEdition, unitLink, hUnitParam, unitsOpenLink, unitsLoad, fLoadHunts,
    fGeneralRows, fTableHunts, fResults, fParse, fRun, vFind, whereAmI, unitsAt, initMap,
    state: () => ({ HU, HT, UNITS, ODDS, DB, units, draw, tab }),
    mode: (stat, now) => { units.static = stat; units.now = now; },
    link: fn => { units.link = fn; }, species: H_SPECIES, openSheet, closeSheet,
    setData: data => { HU = data.HU; HT = data.HT; UNITS = data.UNITS; ODDS = data.ODDS; DB.config = data.config; DB.seasons = data.seasons; },
    drawState: (res, pts) => { draw.res = res; draw.pts = pts; },
    clearHuntData: () => { HU = null; HT = null; ODDS = null; },
    tab: value => { tab = value; },
    mapSetup: () => { loadMapLibs = async () => {}; demSource = () => ({ sharedDemProtocolUrl: 'test-dem', contourProtocolUrl: () => 'test-contours' });
      huntLayers = () => []; drawLegend = () => {}; refreshMapBar = () => {}; }
  };`, box);
  async function flush() {
    if (opts.serveFetches === false) return;
    for (let turn = 0, idle = 0; turn < 80 && idle < 3; turn++) {
      const batch = pending.splice(0); idle = batch.length ? 0 : idle + 1;
      for (const request of batch) {
        const rel = request.url.replace(/^\.\//, ''), file = path.resolve(DOCS, rel);
        if (!file.startsWith(DOCS + path.sep) || !fs.existsSync(file) || (opts.missing && opts.missing.has(path.basename(file)))) {
          request.resolve({ ok: false, status: 404, json: async () => null }); continue;
        }
        try {
          const value = JSON.parse(fs.readFileSync(file, 'utf8'));
          request.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(value)) });
        } catch (e) { request.reject(e); }
      }
      await tick();
    }
    if (pending.length) throw new Error('app fetches did not settle');
  }
  async function loadUnits() { const promise = box.T.unitsLoad(); await flush(); await promise; await flush(); }
  async function click(dataset) {
    const target = { dataset, closest(selector) {
      return Object.keys(dataset).some(key => selector.includes('[data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) + ']')) ? this : null;
    } };
    const promises = (listeners.click || []).map(fn => fn({ target, preventDefault() {}, stopPropagation() {} })).filter(v => v && v.then);
    await flush(); await Promise.all(promises); await flush();
  }
  return { box, T: box.T, scripts, elements, opened, fetched, storageCalls, flush, loadUnits, click,
    reads: () => searchReads, search: value => { searchValue = value; },
    advance: ms => { currentTime += ms; },
    blockStorage: () => { storageBlocked = true; storageCalls.length = 0; },
    enableMap: () => { mapEnabled = true; } };
}

module.exports = { phone };
