#!/usr/bin/env node
/* Packet 5: the real unit renderer, its shared finder rows, and the app's entry
   points. All source/data are the committed app files. The browser and MapLibre
   drawing surface are stubbed; app.js's actual startup/load promises, click
   handlers, GPS callback, and map click callback execute unchanged.

       node scraper/test_units.js

   Clock-only child processes test the Denver edition boundary from six device
   time zones. No source, fixture, page, or data file is written by this suite. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..'), DOCS = path.join(ROOT, 'docs');
const read = f => JSON.parse(fs.readFileSync(path.join(DOCS, 'data/ut', f), 'utf8'));
const INDEX = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
const HU = read('hunt_units_2026.json'), HT = read('hunt_table_2026.json');
const GEO = read('units_geo.json').units, SEASONS = read('seasons.json'), ODDS = read('draw_odds.json');
const LIST_ROWS = Object.values(HU.hunts).flat(), TABLE = new Map(HT.hunts.map(r => [r.code, r]));
const ELIGIBLE = [...new Set(LIST_ROWS.map(r => r.boundary_id))].sort((a, b) => a - b);
const LATEST_YEAR = Object.keys(ODDS.years).sort().pop(), DRAW = ODDS.years[LATEST_YEAR];
const BY_ID = new Map(GEO.map(u => [u.id, u]));
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const text = html => String(html).replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|middot|mdash|ndash);/g, ' ')
  .replace(/&#(?:39|x27);|&apos;/g, "'").replace(/&rsquo;/g, '’').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tick = () => new Promise(resolve => setImmediate(resolve));
let pass = 0, fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail == null ? '' : '\n       ' + String(detail)));
}
function eq(name, actual, expected) { ok(name, same(actual, expected), (JSON.stringify(actual) + ' expected ' + JSON.stringify(expected)).slice(0, 1600)); }

/* Every fetch waits until all of index.html's scripts have loaded. This catches
   a startup hook placed before units.js, or a loader that never opens its deep
   link when data arrive. Returned JSON is cloned, as a real fetch would be. */
function phone(search = '', opts = {}) {
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
  let currentTime = Date.parse('2026-10-15T18:00:00Z');
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
  const scripts = [...INDEX.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(m => m[1]);
  for (const file of scripts) {
    if (/^(?:https?:)?\/\//.test(file)) continue;
    new vm.Script(fs.readFileSync(path.join(DOCS, file), 'utf8'), { filename: file,
      importModuleDynamically: () => Promise.reject(new Error('SunCalc is outside the unit test')) }).runInContext(box);
  }
  vm.runInContext(`this.T = {
    sheetUnit, hEdition, unitLink, hUnitParam, unitsOpenLink, unitsLoad, fLoadHunts,
    fGeneralRows, fTableHunts, fResults, fParse, fRun, vFind, whereAmI, unitsAt, initMap,
    state: () => ({ HU, HT, UNITS, ODDS, DB, units, draw, tab }),
    mode: (stat, now) => { units.static = stat; units.now = now; },
    drawState: (res, pts) => { draw.res = res; draw.pts = pts; },
    clearHuntData: () => { HU = null; HT = null; ODDS = null; },
    tab: value => { tab = value; },
    mapSetup: () => { loadMapLibs = async () => {}; demSource = () => ({ sharedDemProtocolUrl: 'test-dem', contourProtocolUrl: () => 'test-contours' });
      huntLayers = () => []; drawLegend = () => {}; refreshMapBar = () => {}; }
  };`, box);
  async function flush() {
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

const expectedHunts = id => HT.hunts.filter(h => h.boundary_ids.includes(id) && h.list_type &&
  LIST_ROWS.some(r => r.boundary_id === id && r.species === h.species && r.type === h.list_type &&
    !/^(?:General Season|Antlerless)/.test(r.type)));
const displayedCodes = html => [...new Set(text(html).match(/\b(?:DB|EB|PB|MB|BI|DS|RS|GO)\d{4}\b/g) || [])];
const dateWords = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
function expectedSure(h, res) {
  const rows = (h[res] || []).filter(r => r[1] > 0);
  const candidates = rows.filter(r => rows.filter(x => x[0] >= r[0]).every(x => x[2] + x[3] >= x[1]));
  return candidates.length ? Math.min(...candidates.map(r => r[0])) : null;
}
function huntPart(html, code) {
  const at = html.indexOf(code), start = html.lastIndexOf('class="row', at);
  const next = html.indexOf('class="row', at + code.length);
  return text(html.slice(start < 0 ? at : start, next < 0 ? undefined : html.lastIndexOf('<', next)));
}

async function renderChecks() {
  const p = phone(); await p.flush(); await p.loadUnits();
  const state = p.T.state();
  ok('all unit data load through the real promise', !!(state.HU && state.HT && state.UNITS && state.ODDS));
  eq('there are twelve current lists', Object.keys(HU.hunts).length, 12);
  eq('there are 263 current list entries', LIST_ROWS.length, 263);
  eq('exactly 140 polygons have a sheet', ELIGIBLE.length, 140);
  eq('the remaining twelve polygons have no sheet', GEO.length - ELIGIBLE.length, 12);
  ok('all hunt-table rows carry the approved mapping result', HT.hunts.every(r => Object.hasOwn(r, 'list_type')));
  const unplaced = HT.hunts.filter(r => !r.boundary_ids.length).map(r => r.code).sort();
  eq('the three approved unplaced hunts stay unplaced', unplaced, ['DB0008', 'DB1115', 'EB1007']);
  console.log('  Hunt table unplaced: ' + unplaced.length + ' (' + unplaced.join(', ') + ')');
  const htmlById = new Map();
  p.T.mode(true, new Date('2026-10-15T18:00:00Z')); p.blockStorage();
  for (const id of ELIGIBLE) {
    const polygon = BY_ID.get(id), entries = LIST_ROWS.filter(r => r.boundary_id === id);
    let html = ''; try { html = p.T.sheetUnit(id); } catch (e) { ok('sheet renders: ' + polygon.n, false, e.stack); continue; }
    htmlById.set(id, html); const plain = text(html), wanted = expectedHunts(id);
    ok('sheet renders: ' + polygon.n, !!html);
    ok('polygon header uses the boundary spelling: ' + polygon.n, html.includes('<h3>' + esc(polygon.n) + '</h3>'));
    for (const description of new Set(entries.map(r => r.description))) ok('escaped verbatim description: ' + polygon.n, html.includes(esc(description)));
    for (const r of entries) ok('list type is represented: ' + polygon.n + ' / ' + r.type, html.includes(esc(r.type)));
    ok('no empty card: ' + polygon.n, !/<div class="card">\s*<\/div>/.test(html));
    for (const r of entries) if (!p.T.fGeneralRows(r.species, r, null).length && !p.T.fTableHunts(r).length)
      ok('list entry without a guidebook hunt shows UDWR\'s own season label: ' + polygon.n + ' / ' + r.type, plain.includes(r.season), plain.slice(0, 300));
    ok('static sheet has no button or draw target: ' + polygon.n, !/<button\b|\bdata-draw\s*=/i.test(html));
    ok('static sheet has no personal state or hedge: ' + polygon.n, !/\bmaybe\b|Set your points|check the boundary|You, \d+ pt/i.test(plain));
    const actualCodes = displayedCodes(html);
    ok('every displayed hunt code exists: ' + polygon.n, actualCodes.every(c => TABLE.has(c)), actualCodes.filter(c => !TABLE.has(c)).join(', '));
    eq('every mapped draw hunt appears, and no unrelated hunt appears: ' + polygon.n, actualCodes.sort(), wanted.map(h => h.code).sort());
    for (const h of wanted) {
      const part = huntPart(html, h.code);
      ok('printed hunt name retained: ' + h.code + ' on ' + polygon.n, part.includes(h.name), part.slice(0, 160));
      eq('each hunt is rendered once, with only its required date-reference repetition: ' + h.code + ' on ' + polygon.n,
        (plain.match(new RegExp('\\b' + h.code + '\\b', 'g')) || []).length, h.seasons.length ? 1 : 2);
      if (h.weapon) ok('printed weapon retained: ' + h.code + ' on ' + polygon.n, part.toLowerCase().includes(h.weapon.toLowerCase()));
      ok('guidebook sub-heading printed verbatim (cow only, multiseason, management buck): ' + h.code + ' on ' + polygon.n, part.includes(h.hunt_type), part.slice(0, 200));
      for (const span of h.seasons) ok('every printed date span appears: ' + h.code + ' on ' + polygon.n,
        part.includes(dateWords(span.start) + ' to ' + dateWords(span.end)), part);
      if (!h.seasons.length) ok('undated hunt cites its own guidebook code: ' + h.code, plain.includes('Dates: see the 2026 Big Game Application Guidebook, hunt ' + h.code));
      for (const mark of h.marks) ok('guidebook mark immediately follows hunt number: ' + h.code, new RegExp(h.code + '(?:<[^>]+>|\\s)*' + mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(html));
      if (DRAW[h.code]) {
        const draw = DRAW[h.code];
        ok('both draw residencies appear: ' + h.code + ' on ' + polygon.n, /\bresidents\b/i.test(part) && /\bnonresidents\b/i.test(part));
        const residentParts = part.match(/\bresidents\b(.*?)\bnonresidents\b(.*)$/i);
        for (const res of ['r', 'x']) {
          const rows = draw[res] || [], apps = rows.reduce((n, r) => n + r[1], 0), permits = rows.reduce((n, r) => n + r[2] + r[3], 0);
          const sure = expectedSure(draw, res), summary = residentParts ? residentParts[res === 'r' ? 1 : 2] : '';
          ok('draw labels reuse sheetDraw wording: ' + h.code + ' / ' + res, summary.includes('Everyone drew at') && summary.includes('Permits / applicants'), summary);
          ok('permits/applicants agree with draw rows: ' + h.code + ' / ' + res, summary.includes(permits + ' / ' + apps), summary);
          ok('everyone-drew result agrees with draw rows: ' + h.code + ' / ' + res,
            sure == null ? summary.includes('no level') : new RegExp('\\b' + sure + '\\+ pts\\b').test(summary), summary);
        }
      }
    }
    const speciesOrder = ['Deer', 'Elk', 'Pronghorn', 'Moose', 'Bison', 'Bighorn sheep', 'Mountain Goat'];
    const headings = [...html.matchAll(/<div class="sec-title"[^>]*>([^<]*)<\/div>/g)].map(m => text(m[1])).filter(n => speciesOrder.includes(n));
    const expectedSpecies = speciesOrder.filter(s => entries.some(r => s === 'Bighorn sheep' ? /Bighorn Sheep$/.test(r.species) : r.species === s));
    eq('species sections follow packet order: ' + polygon.n, headings, expectedSpecies);
    for (const entry of entries) for (const row of p.T.fGeneralRows(entry.species, entry, null)) {
      ok('general title is the finder builder output: ' + polygon.n + ' / ' + row.t, html.includes(esc(row.t)));
      ok('general sentence is the finder builder output: ' + polygon.n + ' / ' + row.t, html.includes(row.s));
    }
    const base = polygon.n.split(',')[0], named = GEO.filter(u => u.id !== id && u.n.startsWith(base)), others = named.filter(u => ELIGIBLE.includes(u.id));
    if (named.length) {
      ok('name-neighbour label is literal: ' + polygon.n, plain.includes('Other units named ' + base + ':'));
      for (const other of others) ok('every name-neighbour with a sheet has a link: ' + polygon.n + ' -> ' + other.n, html.includes('/?unit=' + HU.slugs[other.n]));
      for (const other of named) ok('every name-neighbour is named, with or without a sheet: ' + polygon.n + ' -> ' + other.n, plain.includes(other.n));
      eq('neighbour links go only to polygons with a sheet: ' + polygon.n, (html.match(/>Open unit<\/a>/g) || []).length, others.length);
    } else ok('no name-neighbour line without a name match: ' + polygon.n, !plain.includes('Other units named'));
    ok('source footer names the year and actual list pull date: ' + polygon.n, plain.includes("Hunts: UDWR's 2026 hunt boundary lists, pulled") && plain.includes((HU._source.match(/pulled (\d{4}-\d{2}-\d{2})/) || [])[1]));
    ok('source footer names both guidebooks, edition and last draw year: ' + polygon.n, plain.includes('2026 Big Game Field Regulations (general seasons)') && plain.includes('2026 Big Game Application Guidebook') && plain.includes(HT._edition.reissued) && plain.includes("Last year's draw: " + LATEST_YEAR));
    ok('footnote explanation appears once: ' + polygon.n, plain.split("A mark after a hunt number is the guidebook's footnote; read it there.").length === 2);
  }
  eq('rendering never touches localStorage', p.storageCalls, []);
  const early = SEASONS.seasons.find(r => r.id === 'deer-early-rifle').units;
  const earlyIds = [...new Set(LIST_ROWS.filter(r => r.type === 'General Season' && r.species === 'Deer' && early.includes(r.unit)).map(r => r.boundary_id))].sort((a, b) => a - b);
  const actualEarly = [...htmlById].filter(([, h]) => /Early (?:Oct|October)\.?\s*7(?:,?\s*2026)?\s+to\s+(?:Oct|October)\.?\s*11/i.test(text(h))).map(([id]) => id).sort((a, b) => a - b);
  eq('only the twelve named units carry the early deer sentence', actualEarly, earlyIds);
  const forName = n => htmlById.get(GEO.find(u => u.n === n).id) || '';
  ok('Paunsaugunt carries no general any-bull archery hunt', !/Any-bull elk, general archery/i.test(text(forName('Paunsaugunt'))));
  for (const row of HU.hunts.elk_spike.filter(r => r.unit.startsWith('Book Cliffs'))) {
    ok('Book Cliffs archery is spike bull only: ' + row.unit, /Spike elk, general archery[^]*?Spike bull only/i.test(text(htmlById.get(row.boundary_id))));
  }
  for (const name of ['Cache', 'Beaver, West', 'Boulder/Kaiparowits']) {
    const plain = text(forName(name));
    ok('restricted rifle and muzzleloader: ' + name, /restricted rifle/i.test(plain) && /restricted muzzleloader/i.test(plain));
    ok('no-scopes sentence on restricted unit: ' + name, /no scopes of any kind/i.test(plain));
  }
  for (const code of ['DS6608', 'DS6610']) {
    const hunt = TABLE.get(code); eq('marked sheep hunt retains only its printed unit: ' + code, hunt.boundary_ids.length, 1);
    const html = htmlById.get(hunt.boundary_ids[0]); ok('sheep footnote is not interpreted: ' + code, !/Nonresidents may hunt both/i.test(text(html)));
  }
  const wasatch = GEO.find(u => u.n === 'Wasatch Mtns');
  const fillmore = GEO.find(u => u.n === 'Fillmore B');
  ok('Fillmore B sheet carries its own general deer card', /General buck deer/.test(text(htmlById.get(fillmore.id))));
  const baseAnswer = p.T.fResults({ sp: 'deer', wp: null }, ['Fillmore']);
  ok('the out-of-scope Fillmore base matcher is unchanged', !baseAnswer.some(c => c.title === 'Deer - general season (draw, preference points)'));
  const saved = htmlById.get(wasatch.id); p.T.drawState('r', { 'Limited entry and once-in-a-lifetime|Elk': 0 });
  eq('personal residency/points cannot change static unit output', p.T.sheetUnit(wasatch.id), saved);
  p.T.mode(false, new Date('2026-10-15T18:00:00Z'));
  for (const id of ELIGIBLE) {
    const html = p.T.sheetUnit(id), wanted = expectedHunts(id);
    for (const h of wanted) ok('live draw tap target follows data availability: ' + h.code + ' / ' + id,
      new RegExp('data-draw="' + h.code + '"').test(html) === !!DRAW[h.code]);
    ok('live sheet still has no personal points prompt: ' + id, !/Set your points|You, \d+ pt/.test(text(html)));
    const link = p.T.unitLink(id);
    ok('live unit link targets the stored slug and polygon id: ' + id, link.includes('href="/?unit=' + HU.slugs[BY_ID.get(id).n] + '"') && link.includes('data-unit="' + id + '"') && text(link) === 'Open unit');
  }
  for (const u of GEO.filter(u => !ELIGIBLE.includes(u.id))) eq('no link for a polygon without hunts: ' + u.n, p.T.unitLink(u.id), '');
  p.T.mode(true, new Date('2026-10-15T18:00:00Z'));
  ok('static links keep their destination without app interaction data', p.T.unitLink(wasatch.id).includes('/?unit=' + HU.slugs[wasatch.n]) && !/data-unit/.test(p.T.unitLink(wasatch.id)));
  eq('live and static unit rendering never touches localStorage', p.storageCalls, []);
  p.T.clearHuntData();
  let withoutLists; try { withoutLists = p.T.unitLink(wasatch.id); } catch (e) { withoutLists = 'threw: ' + e.message; }
  eq('unit shapes loaded but hunt lists missing: the unit link is empty and does not throw', withoutLists, '');
}

function dayAfter(iso) { return new Date(Date.parse(iso + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10); }
async function clockChecks() {
  const p = phone(); await p.flush(); await p.loadUnits(); const id = GEO.find(u => u.n === 'Cache').id;
  const ends = SEASONS.seasons.filter(s => ['deer', 'elk', 'pronghorn', 'moose', 'bison', 'sheep', 'mountain goat'].includes(s.group)).map(s => s.end)
    .concat(HT.hunts.flatMap(r => r.seasons.map(s => s.end)));
  const latest = ends.sort().pop(), next = dayAfter(latest), banner = 'These are the 2026 hunts. The 2027 guidebooks have not been read into Ranger Hawk yet.';
  eq('edition derives its last and expiry dates from the data', [p.T.hEdition().last, p.T.hEdition().expires], [latest, next]);
  for (const iso of ['2026-10-15T18:00:00Z', '2026-12-31T19:00:00Z', latest + 'T19:00:00Z']) {
    p.T.mode(true, new Date(iso)); ok('edition banner absent through current edition: ' + iso, !text(p.T.sheetUnit(id)).includes(banner));
  }
  p.T.mode(true, new Date(next + 'T19:00:00Z')); ok('edition banner starts the computed next day: ' + next, text(p.T.sheetUnit(id)).includes(banner));
  /* The current cycle ends in January: Denver midnight is 07:00Z. Compute that
     instant from the date's real UTC offset rather than the device's zone. */
  const noon = new Date(next + 'T19:00:00Z'), parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: '2-digit', hourCycle: 'h23' }).formatToParts(noon);
  const hour = Number(parts.find(p => p.type === 'hour').value), midnight = noon.getTime() - hour * 3600000;
  p.T.mode(true, new Date(midnight - 1)); ok('Denver day has not ended one millisecond before midnight', !text(p.T.sheetUnit(id)).includes(banner));
  p.T.mode(true, new Date(midnight)); ok('edition changes exactly at Denver midnight', text(p.T.sheetUnit(id)).includes(banner));
}

async function linkChecks() {
  const known = GEO.find(u => u.n === 'Cache'), slug = HU.slugs[known.n];
  const p = phone('?unit=' + slug);
  eq('startup has not opened a unit before base data arrive', p.opened.length, 0);
  ok('index loads units.js after finder.js', p.scripts.indexOf('units.js') > p.scripts.indexOf('finder.js'));
  await p.flush();
  ok('real app startup fetched hunt lists, table, polygons and odds', ['hunt_units_2026.json', 'hunt_table_2026.json', 'units_geo.json', 'draw_odds.json'].every(f => p.fetched.some(u => u.endsWith('/' + f))));
  eq('real app startup opens known unit exactly once', p.opened.length, 1);
  ok('startup opens the actual Cache unit renderer', (p.opened[0] || '').includes('<h3>Cache</h3>'));
  eq('known unit parameter is read once', p.reads(), 1);
  p.search('?unit=unknown'); eq('reader retains the first parameter', p.T.hUnitParam(), slug);
  eq('repeated opener does nothing', p.T.unitsOpenLink(), false);
  await p.loadUnits(); eq('repeated loader never opens the original link twice', p.opened.length, 1);
  for (const search of ['', '?other=cache', '?unit=', '?unit=not-a-unit', '?unit=__proto__', '?unit=constructor']) {
    const q = phone(search); await q.flush(); await q.loadUnits();
    eq('unknown or absent parameter opens nothing: ' + (search || '(none)'), q.opened.length, 0);
    eq('unknown or absent opener stays inert: ' + (search || '(none)'), q.T.unitsOpenLink(), false);
    eq('unit parameter is read at most once: ' + (search || '(none)'), q.reads(), 1);
  }
  const stat = phone('?unit=' + slug); stat.T.mode(true, new Date('2026-10-15T18:00:00Z')); await stat.flush(); await stat.loadUnits();
  eq('static mode never reads the URL or opens a deep link', [stat.reads(), stat.opened.length, stat.T.hUnitParam(), stat.T.unitsOpenLink()], [0, 0, null, false]);
  eq('slug values are unique', new Set(Object.values(HU.slugs)).size, Object.keys(HU.slugs).length);
  const direct = phone(); await direct.flush(); await direct.loadUnits(); await direct.click({ unit: String(known.id) });
  eq('the real document unit-link listener opens once', direct.opened.length, 1);
  ok('the real unit-link listener selects its polygon', (direct.opened[0] || '').includes('<h3>Cache</h3>'));
  const drawHunt = expectedHunts(known.id).find(h => DRAW[h.code]);
  if (drawHunt) {
    await direct.click({ draw: drawHunt.code });
    eq('a unit hunt tap executes the existing draw-sheet handler once', direct.opened.length, 2);
    ok('the unit hunt tap opens its actual draw result', (direct.opened[1] || '').includes(esc(DRAW[drawHunt.code].n)) && (direct.opened[1] || '').includes(drawHunt.code));
  }
  const excluded = GEO.find(u => !ELIGIBLE.includes(u.id)), openedBefore = direct.opened.length;
  await direct.click({ unit: String(excluded.id) });
  eq('a direct event for a polygon without hunts opens no empty sheet', direct.opened.length, openedBefore);
  for (const file of ['hunt_units_2026.json', 'hunt_table_2026.json', 'draw_odds.json']) {
    const missing = new Set([file]), q = phone('?unit=' + slug, { missing }); await q.flush();
    eq('a missing dataset cannot open an incomplete unit sheet: ' + file, q.opened.length, 0);
    missing.clear(); q.advance(20001); await q.loadUnits();
    eq('a successful retry opens the held unit parameter once: ' + file, q.opened.length, 1);
    await q.loadUnits(); eq('retry never opens the same parameter twice: ' + file, q.opened.length, 1);
  }
}

/* Independent ray crossing picks a real interior point, so the entry-point
   tests use app.js's unitsAt() rather than replacing it with handpicked hits. */
function inRing(point, ring) {
  let inside = false; const [x, y] = point;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = ring[i], [c, d] = ring[j]; if ((b > y) !== (d > y) && x < (c - a) * (y - b) / (d - b) + a) inside = !inside;
  }
  return inside;
}
function interior(unit) {
  const [x0, y0, x1, y1] = unit.bb;
  for (let i = 1; i < 20; i++) for (let j = 1; j < 20; j++) {
    const point = [x0 + (x1 - x0) * i / 20, y0 + (y1 - y0) * j / 20];
    if (unit.p.some(poly => inRing(point, poly[0]) && !poly.slice(1).some(r => inRing(point, r)))) return point;
  }
  throw new Error('no interior sample for ' + unit.n);
}
async function entryChecks() {
  const p = phone(); await p.flush(); await p.loadUnits(); const cache = GEO.find(u => u.n === 'Cache'), point = interior(cache);
  p.box.gps = { lon: point[0], lat: point[1] };
  await p.T.whereAmI(); await p.flush(); const where = p.opened[p.opened.length - 1] || '';
  const hits = p.T.unitsAt(point[0], point[1]); ok('Where am I uses an actual Cache point', hits.some(u => u.id === cache.id));
  for (const u of hits) {
    ok('Where am I names each actual polygon: ' + u.n, where.includes(esc(u.n)));
    if (ELIGIBLE.includes(u.id)) ok('Where am I links each polygon with hunts: ' + u.n, where.includes('data-unit="' + u.id + '"'));
    else ok('Where am I leaves a polygon without hunts as a name: ' + u.n, !where.includes('data-unit="' + u.id + '"'));
  }
  for (const u of GEO.filter(u => !ELIGIBLE.includes(u.id))) {
    const sample = interior(u); p.box.gps = { lon: sample[0], lat: sample[1] };
    await p.T.whereAmI(); await p.flush(); const html = p.opened[p.opened.length - 1] || '';
    ok('Where am I preserves the name without a link for every excluded polygon: ' + u.n,
      html.includes(esc(u.n)) && !html.includes('data-unit="' + u.id + '"'));
  }
  const callbacks = {}, popups = [], sources = {};
  class FakeMap {
    addControl() {} on(kind, layer, fn) { (callbacks[kind] ||= []).push(typeof layer === 'function' ? layer : fn); }
    getStyle() { return {}; } addSource(name, value) { sources[name] = value; } addLayer() {} getLayer() { return null; }
    queryRenderedFeatures() { return []; } getCanvas() { return { style: {} }; } remove() {}
  }
  class FakePopup { setLngLat() { return this; } setHTML(html) { popups.push(html); return this; } addTo() { return this; } }
  p.box.pmtiles = { Protocol: class { constructor() { this.tile = () => {}; } } };
  p.box.maplibregl = { Map: FakeMap, Popup: FakePopup, addProtocol() {}, NavigationControl: class {}, GeolocateControl: class {}, ScaleControl: class {} };
  p.enableMap(); p.T.mapSetup(); p.T.tab('map'); await p.T.initMap();
  const loading = Promise.all((callbacks.load || []).map(fn => fn())); await p.flush(); await loading;
  const clicks = (callbacks.click || []); ok('the actual map registers its general click handler', clicks.length >= 2);
  const click = clicks[clicks.length - 1]; if (click) await click({ point: { x: 0, y: 0 }, lngLat: { lng: point[0], lat: point[1] } }); await p.flush();
  const popup = popups[popups.length - 1] || ''; ok('actual map click opens a unit popup', !!popup);
  for (const u of hits) if (ELIGIBLE.includes(u.id)) ok('actual map popup links each polygon with hunts: ' + u.n, popup.includes('data-unit="' + u.id + '"'));
  if (sources.units) ok('map unit features retain BoundaryID', sources.units.data.features.every(f => f.properties.id != null || f.properties.boundary_id != null));
  if (click) for (const u of GEO.filter(u => !ELIGIBLE.includes(u.id))) {
    const sample = interior(u); await click({ point: { x: 0, y: 0 }, lngLat: { lng: sample[0], lat: sample[1] } }); await p.flush();
    const html = popups[popups.length - 1] || '';
    ok('map popup preserves the name without a link for every excluded polygon: ' + u.n,
      html.includes(esc(u.n)) && !html.includes('data-unit="' + u.id + '"'));
  }
  if (click) {
    p.T.clearHuntData(); const before = popups.length;
    const pendingClick = click({ point: { x: 0, y: 0 }, lngLat: { lng: point[0], lat: point[1] } });
    await p.click({ tab: 'today' }); await pendingClick;
    eq('leaving the map during a deferred hunt fetch opens no stale popup', popups.length, before);
    eq('navigation away from a pending map click keeps the selected screen', p.T.state().tab, 'today');
  }
  const find = phone(); await find.flush(); await find.loadUnits(); find.T.fRun('elk on Wasatch Mtns'); await find.flush();
  const finder = find.T.vFind(); ok('finder rows expose an Open unit link', /data-unit="222"/.test(finder) && /Open unit/.test(finder));
  const shell = fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf8');
  for (const file of ['./units.js', './data/ut/hunt_table_2026.json']) eq('service-worker SHELL includes exactly once: ' + file, [...shell.matchAll(new RegExp('[\'\"]' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'\"]', 'g'))].length, 1);
}

(async () => {
  if (process.argv.includes('--clock-only')) await clockChecks();
  else {
    await renderChecks(); await clockChecks(); await linkChecks(); await entryChecks();
    for (const zone of ['America/Denver', 'UTC', 'America/Los_Angeles', 'Pacific/Honolulu', 'Asia/Kathmandu', 'Pacific/Auckland']) {
      const child = spawnSync(process.execPath, [__filename, '--clock-only'], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
      ok('Denver edition boundary is independent of device time zone: ' + zone, child.status === 0, child.stdout + child.stderr);
    }
  }
})().catch(e => { fail++; console.log('  FAIL unit checks\n       ' + e.stack); }).then(() => {
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
});
