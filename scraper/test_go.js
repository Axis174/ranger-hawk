#!/usr/bin/env node
/* Checks where the Menu sends a typed sentence (docs/go.js): which screen opens,
   which finder runs, whether a search was run at all, and for the fishing finder
   whether it came back with waters or with its "does not know that water" box.
   It loads the real docs/state.js, docs/finder.js, docs/fishing.js and docs/go.js with
   the data in docs/data and the browser stubbed. The home towns section at the end
   also loads docs/site.js and cuts the header, the drive time and the click handlers
   out of docs/app.js. Run with:

       node scraper/test_go.js

   GO_JS=<file> runs the same checks against another copy of go.js, which is how
   the checks were shown to fail on the v27 Menu before it was fixed. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..'), D = p => path.join(ROOT, 'docs', p);
const load = f => JSON.parse(fs.readFileSync(D('data/ut/' + f), 'utf8'));
const GO = process.env.GO_JS || D('go.js');
/* The app's own point-in-unit code (app.js), so a water's point is turned into hunt units the way the app does it. */
const APP_SRC = fs.readFileSync(D('app.js'), 'utf8');
const APP_GEO = APP_SRC.slice(APP_SRC.indexOf('function inRing'), APP_SRC.indexOf('async function whereAmI'));
/* The pieces of app.js the home towns work through: the header (renderChrome), the drive time of an access
   point, the point sheet, and the click and change handlers. A piece that has moved stops the run here,
   not in the middle of a test. */
function appPart(from, to) {
  const a = APP_SRC.indexOf(from), b = APP_SRC.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error('app.js no longer holds "' + (a < 0 ? from : to) + '"');
  return APP_SRC.slice(a, b);
}
const APP_CHROME = appPart('const TABS = [', 'function render() {');
const APP_DRIVE = appPart('function drive(p) {', '/* ---------------------------------------------------------- legal light');
const APP_SHEET = appPart('function sheetPoint(p) {', 'function sheetSeason(s) {');
const APP_EVENTS = appPart("document.addEventListener('click', e => {", "document.addEventListener('keydown'") + appPart("document.addEventListener('change', e => {", 'function net() {');

/* The clock is stopped, as in the fishing tests, so the answer is the same any day. */
const FIXED = Date.UTC(2026, 8, 27, 18, 0, 0);
class TestDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(FIXED); }
  static now() { return FIXED; }
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DATA = {
  config: load('config.json'), seasons: load('seasons.json'), birds: load('bird_access.json'), units: load('units_geo.json').units,
  rules: load('fishing_rules.json'), places: load('fishing_places.json'), notices: load('fishing_notices.json')
};
/* What one hunter's phone holds (docs/state.js keeps it in localStorage): three chosen towns, each with
   the words the finders used to listen for before the towns became public, and the header on the middle
   one. Every page starts from this unless a test hands it other storage, so the sentences below are
   read the way they always were. */
const HUNTER = {
  'ha.anchors': JSON.stringify([
    { id: 'slc', words: ['north salt lake', 'nsl', 'salt lake'] },
    { id: 'heber', words: ['cabin', 'treetop', 'tree top', 'timber lakes', 'heber'] },
    { id: 'torrey', words: ['torrey', 'boulder', 'the boulders', 'fishlake'] }]),
  'ha.anchor': 'heber'
};

/* One page. withFishing false is the first run: the fishing rules have not arrived,
   so no water's name is known. net.on says whether a fetch of docs/data succeeds.
   opts.ls is the phone's storage to start from (an object or a Map; HUNTER when left out), and
   opts.app also loads site.js and the parts of app.js the home towns work through. */
const FILES = { 'fishing_rules.json': DATA.rules, 'fishing_places.json': DATA.places, 'fishing_notices.json': DATA.notices };
function page(withFishing, net, opts) {
  net = net || { on: false };
  opts = opts || {};
  const store = new Map(opts.ls instanceof Map ? opts.ls : Object.entries(opts.ls || HUNTER));
  const runs = [], timers = [], landed = [], renders = [], gps = [];
  let nextTimer = 1;
  const box = {
    console, Date: TestDate, Math, JSON, Object, Array, String, Number, RegExp, Promise, Set, Map, Intl,
    document: { addEventListener(type, fn) { (box.LISTENERS[type] = box.LISTENERS[type] || []).push(fn); } },
    LISTENERS: {},
    window: { scrollTo() {}, addEventListener() {} },
    navigator: { geolocation: { getCurrentPosition() { gps.push(box.tab); } } }, localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem(k, v) { store.set(k, String(v)); }, removeItem(k) { store.delete(k); } },
    fetch(url) {
      const j = FILES[String(url).split('/').pop()];
      return net.on && j ? Promise.resolve({ ok: true, json: () => Promise.resolve(j) }) : Promise.reject(new Error('no network in tests'));
    },
    /* The finders are started 30 ms after the screen is drawn: run those at once.
       Anything later (the tags landing retries) waits in a queue the test can inspect. */
    setTimeout(fn, ms) { if (!(ms > 30)) { fn(); return 0; } const id = nextTimer++; timers.push({ id, fn }); return id; },
    clearTimeout(id) { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); },
    els: {}, $: id => box.els[id] || null,
    /* As the app does: note which screen was drawn, and draw the Fish screen with vFish. */
    render() { renders.push(box.tab); if (box.tab === 'fish' && box.T_vFish) box.T_vFish(); },
    openSheet() {}, closeSheet() {}, loadWx() {},
    tab: 'today', seasonsMode: 'dates', esc,
    miles(aLat, aLon, bLat, bLon) {
      const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
      return 3958.8 * 2 * Math.asin(Math.sqrt(h));
    },
    DB: { config: DATA.config, seasons: DATA.seasons, birds: DATA.birds },
    UNITS: DATA.units, ODDS: null, draw: { pts: {} }, loadOdds() {},
    fmt: d => String(d), d0: s => new Date(s), unitsAt: () => []
  };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(D('state.js'), 'utf8'), box);   // the chosen towns, read from the stubbed storage
  vm.runInContext(APP_GEO, box);
  vm.runInContext(fs.readFileSync(D('finder.js'), 'utf8') + '\n;this.T_fq = () => fq; this.T_hu = j => { HU = j; };', box);
  vm.runInContext(fs.readFileSync(D('fishing.js'), 'utf8') +
    '\n;this.T_fish = () => fish; this.T_vFish = vFish; this.T_state = () => fishState;' +
    ' this.T_set = function (r, p, n) { FR = r; FP = p || F_NOPLACES(); FNT = n; fNames = null; if (r) fishIndex(); fishState = "ready"; };', box);
  if (withFishing) box.T_set(DATA.rules, DATA.places, DATA.notices);
  vm.runInContext(fs.readFileSync(GO, 'utf8') + '\n;this.T_go = { goSubmit, goOpen, GO_DEST };', box);
  const realHunt = box.fRun, realFish = box.fishRun;
  box.fRun = q => { runs.push('hunt'); realHunt(q); };
  box.fishRun = q => { runs.push('fish'); realFish(q); };
  if (opts.app) {
    for (const id of ['homesel', 'tabs', 'title', 'view']) box.els[id] = {};
    box.alerts = () => 0;
    for (const src of [fs.readFileSync(D('site.js'), 'utf8'), APP_CHROME, APP_DRIVE, APP_SHEET, APP_EVENTS]) vm.runInContext(src, box);
    /* As render() does in the app: the header, then the Home towns page when that is the screen. */
    box.render = function () { renders.push(box.tab); box.renderChrome(); if (box.tab === 'towns') box.els.view.innerHTML = box.vTowns(); };
  }

  /* Type a sentence into the Menu and press Enter. */
  function type(text) {
    runs.length = 0; box.tab = 'today'; box.seasonsMode = 'dates';
    const f = box.T_fish(); f.q = ''; f.parsed = null; f.mode = 'near';
    box.T_go.goSubmit(text);
    const r = { tab: box.tab, mode: box.seasonsMode, run: runs.join('+') || 'none' };
    if (r.run === 'fish') {
      const html = box.T_vFish(), p = box.T_fish().parsed || {};
      r.rows = rowsIn(html);
      r.unknown = /does not know a water called/.test(html);
      r.nomatch = /Nothing in the guidebook's list matched/.test(html);
      r.water = p.water ? p.water.needle : null;
      r.html = html;
    }
    if (r.run === 'hunt') {
      const p = box.T_fq().parsed || {};
      r.fishAnswer = !!p.fish;
      r.sp = p.fish ? null : p.sp || (p.bird && p.bird[0]) || (p.gap && p.gap[0]) || null;
    }
    return r;
  }
  return { box, type, timers, landed, renders, gps, store };
}

const rowsIn = html => (html.match(/data-f[wp]="/g) || []).length;
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail ? '\n       got ' + detail : ''));
}
const show = r => JSON.stringify(Object.assign({}, r, { html: undefined }));

const P = page(true);
const tabOf = id => P.box.T_go.GO_DEST.find(d => d.id === id);

/* A screen opened with no search run. */
function screen(text, tab, mode, pg) {
  const r = (pg || P).type(text);
  ok(`"${text}" opens ${tab}${mode ? '/' + mode : ''} with no search`, r.tab === tab && r.run === 'none' && (!mode || r.mode === mode), show(r));
}
/* The hunt finder, reading the animal named (or null for its own no-match). */
function hunt(text, sp, pg) {
  const r = (pg || P).type(text);
  const spOk = sp === undefined || r.sp === sp;
  ok(`"${text}" goes to the hunt finder${sp ? ' as ' + sp : ''}`, r.run === 'hunt' && r.tab === 'seasons' && r.mode === 'find' && !r.fishAnswer && spOk, show(r));
}
/* The fishing finder, with waters on the screen and no "unknown" or "nothing matched" box. */
function fishing(text, check) {
  const r = P.type(text);
  ok(`"${text}" goes to the fishing finder with results`, r.run === 'fish' && r.tab === 'fish' && r.rows > 0 && !r.unknown && !r.nomatch, show(r));
  if (check) ok(`"${text}": ${check[0]}`, check[1](r), show(r));
}
/* Never a fishing search, whatever else happens. */
function notFishing(text) {
  const r = P.type(text);
  ok(`"${text}" stays on the Hunt screen and runs no fishing search`, r.run !== 'fish' && r.tab === 'seasons' && r.mode === 'find' && !r.fishAnswer, show(r));
}

/* ---- 1. The review's blocking sentences: a sentence the fishing finder cannot use
        opens the plain Fish screen, as v27 did, not an empty search. */
for (const s of ['i want to go fishing', 'fishing report', 'fishing spots', 'show me fishing', 'water levels', 'go fishing']) screen(s, 'fish');

/* ---- 2. A water's short name is not an animal. */
hunt('deer near duck fork', 'deer');
hunt('elk near quail creek', 'elk');
hunt('ducks near duck fork', 'duck');
fishing('duck fork', ['searches that water', r => r.water === 'duck fork']);
fishing('is duck fork open');

/* ---- 3. A hunting property said on its own opens Access, as v27 did. */
screen('bear river bay wma', 'access');
screen('stewart lake wma', 'access');
screen('lower fish creek wma', 'access');
screen('fish creek walk in access', 'access');
fishing('trout at stewart lake wma');
fishing('strawberry river wma rules');

/* ---- 4. A hunting sentence beside Fish Lake is never a fishing search. */
notFishing('hunt near fish lake');
notFishing('cougar hunting at fish lake');

/* ---- The water's name holds a screen word, or an animal. */
hunt('deer near fish lake', 'deer');
hunt('deer near fish creek', 'deer');
fishing('trout at fish lake', ['reads Fish Lake', r => r.water === 'fish lake']);
fishing('fish lake', ['searches that water', r => r.water === 'fish lake']);
fishing('fish lake rules');
fishing('kokanee at deer creek');
fishing('walleye at deer creek', ['lists Deer Creek Reservoir', r => /deer creek reservoir/i.test(r.html)]);
fishing('bass at quail creek reservoir');
fishing('bear lake cutthroat');
{
  /* The app knows no Elk Lake. It says so, and still lists trout waters: a fishing answer, not a hunt. */
  const r = P.type('trout at elk lake');
  ok('"trout at elk lake" goes to the fishing finder, which says it does not know that water', r.run === 'fish' && r.tab === 'fish' && r.unknown && r.rows > 0, show(r));
}

/* ---- Sentences from earlier audits and the Menu's own examples. */
hunt('deer near antelope island', 'deer');
hunt('pheasant near north salt lake', 'pheasant');
hunt('elk by the cabin', 'elk');
hunt('elk at strawberry', 'elk');
hunt('tushar mountain goat', 'mountain goat');
fishing('trout near home');
fishing('trout near the cabin');
fishing('fishing in carbon county');
fishing('strawberry', ['reads Strawberry by its one-word name', r => r.water === 'strawberry']);
fishing('bass');
hunt('carbon county', null);                          // a county alone stays with the hunt finder, as v27
hunt('sheep near sheep creek', 'sheep');
hunt('chukar near fish springs', 'chukar');
hunt('deer season', 'deer');                          // not Season dates: the animal decides
hunt('elk permit', 'elk');                            // not Reminders: the animal decides

/* ---- A fishing word beats any animal; a hunting word and an animal with no fishing word is a hunt. */
function fishTab(text, pg) {
  const r = (pg || P).type(text);
  ok(`"${text}" goes to the Fish screen, not the Hunt screen`, r.tab === 'fish' && r.run !== 'hunt', show(r));
  return r;
}
for (const s of ['fishing at elk lake', 'ice fishing at goose lake', 'fishing at sheep creek lake', 'fishing at duck fork']) fishTab(s);
fishing('fishing at sheep creek lake', ['reads Sheep Creek Lake', r => r.water === 'sheep creek lake']);
fishing('fishing at duck fork', ['reads Duck Fork', r => r.water === 'duck fork']);
hunt('elk hunting at fish lake', 'elk');
screen('angling', 'fish');                            // a fishing word and nothing else: Fish, not the hunt finder

/* ---- Distinctive screen words still win outright. */
screen('deer cams', 'cams');
screen('draw odds elk', 'seasons', 'draw');
screen('wma near home', 'access');
screen('my points', 'seasons', 'draw');
screen('fishing permit', 'fish');
{
  const r = P.type('find a hunt for elk');
  ok('"find a hunt for elk" opens the hunt finder with the sentence', r.run === 'hunt' && r.tab === 'seasons' && r.mode === 'find' && r.sp === 'elk', show(r));
}

/* ---- A lake, reservoir or pond named in a hunting sentence is a spot to hunt around. Its one point
        in the fishing data is put under the hunt boundaries with the app's own unitsAt. Every check
        reads what is DRAWN (vFind) and, for a hunt, that a place was found AND rows came back, so a
        sentence that stops on "Where?" no longer passes as an answer. Sentences go in through the
        Menu (goSubmit -> goRoute -> fRun -> fParse), the route "What do you want to do?" takes. */
{
  P.box.T_hu(load('hunt_units_2026.json'));
  P.box.ODDS = load('draw_odds.json');
  const CAUTION = (label) => `Units at one point on ${label} A lake can touch more than one hunt unit. Check the unit boundary map before you hunt.`;
  const RIVER = 'A river runs through many hunt units. Pick a place, name a unit, or use Where I am now.';
  const NOPOINT = 'Ranger Hawk has no map point for that water. Pick a place, name a unit, or use Where I am now.';
  const text = h => h.replace(/<[^>]*>/g, '|').replace(/&middot;/g, '.').replace(/&amp;/g, '&');
  const answer = (sentence, pg) => {
    pg = pg || P;
    const r = pg.type(sentence);
    const q = pg.box.T_fq().parsed || {};
    const html = r.run === 'hunt' ? pg.box.vFind() : '';
    const units = q.place ? (q.place.units || (q.place.lat != null ? pg.box.unitsAt(q.place.lon, q.place.lat).map(u => u.n) : [])) : [];
    return { r, q, html, txt: text(html), units, rows: (html.match(/class="row"/g) || []).length, asks: /<div class="sec-title">Where\?</.test(html),
      which: /<div class="sec-title">Which one\?</.test(html), nothing: /Nothing matched in/.test(html), head: (/class="sec-title">([^<]*)</.exec(html.replace(/^[\s\S]*?<\/form>/, '')) || [])[1] || '' };
  };
  const click = (pg, attrs) => {                       // a tap on a chip: the page's own click handlers
    const el = { dataset: attrs };
    const ev = { target: { closest: sel => (Object.keys(attrs).some(k => sel.indexOf('[data-' + k + ']') >= 0) ? el : null) } };
    (pg.box.LISTENERS.click || []).forEach(fn => fn(ev));
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /* 1. The bug: Fish Lake. */
  {
    const a = answer('deer near fish lake');
    ok('Menu: "deer near fish lake" reaches the hunt finder', a.r.run === 'hunt' && a.r.tab === 'seasons' && a.r.mode === 'find' && !a.r.fishAnswer, show(a.r));
    ok('"deer near fish lake": the place is Fish Lake, Sevier Co. (the full place name and county, not the typed text) at its point',
      a.q.place && a.q.place.kind === 'water' && a.q.place.label === 'Fish Lake, Sevier Co.' && a.q.place.lat === 38.5481 && a.q.place.lon === -111.70987 && !a.q.place.units, JSON.stringify(a.q.place));
    ok('"deer near fish lake": the units at that point are Fishlake, Fishlake/Thousand Lakes and Plateau', same(a.units.slice().sort(), ['Fishlake', 'Fishlake/Thousand Lakes', 'Plateau']), JSON.stringify(a.units));
    ok('"deer near fish lake": answers with deer rows (8) and does not stop on "Where?"', a.rows === 8 && !a.asks && !a.which && !a.nothing && /Deer/.test(a.head), JSON.stringify({ rows: a.rows, asks: a.asks, head: a.head }));
    ok('"deer near fish lake": says "Units at one point on Fish Lake, Sevier Co. A lake can touch more than one hunt unit. Check the unit boundary map before you hunt."',
      a.txt.indexOf(CAUTION('Fish Lake, Sevier Co.')) >= 0, a.txt.slice(0, 220));
    ok('"deer near fish lake": the sentence is in the caution style (warnbox) and comes before the heading and every row',
      /<div class="warnbox"[^>]*>Units at one point on Fish Lake, Sevier Co\. A lake/.test(a.html) && a.html.indexOf('Units at one point') < a.html.indexOf('class="sec-title"') && a.html.indexOf('Units at one point') < a.html.indexOf('class="row"'), a.html.slice(0, 200));
    ok('"deer near fish lake": the label is escaped (no markup from a name)', !/Fish Lake, Sevier Co\.\.|<script/.test(a.html), 'double period or markup');
  }
  {
    const a = answer('elk near fish lake');
    ok('"elk near fish lake": elk rows (7) from the elk unit the lake is in', a.rows === 7 && a.units.indexOf('Fishlake/Thousand Lakes') >= 0 && !a.asks && !a.nothing && a.txt.indexOf(CAUTION('Fish Lake, Sevier Co.')) >= 0, JSON.stringify({ rows: a.rows, units: a.units }));
    const b = answer('elk hunting at fish lake');
    ok('"elk hunting at fish lake": the same Fish Lake spot', b.q.place && b.q.place.label === 'Fish Lake, Sevier Co.' && b.rows === 7, JSON.stringify({ rows: b.rows }));
    const c = answer('pronghorn near fish lake');
    ok('"pronghorn near fish lake": units under the lake (incl. Plateau), the data has no pronghorn hunt there so the normal "Nothing matched" line, not "Where?"', c.q.place && c.units.indexOf('Plateau') >= 0 && c.nothing && !c.asks, JSON.stringify({ units: c.units, nothing: c.nothing }));
    const d = answer('strawberry reservoir deer');
    ok('"strawberry reservoir deer": answers from the units under that reservoir', d.q.place && d.q.place.label === 'Strawberry Reservoir, Wasatch Co.' && d.units.indexOf('Wasatch Mtns') >= 0 && d.rows > 0 && !d.asks, JSON.stringify({ label: d.q.place && d.q.place.label, units: d.units, rows: d.rows }));
  }
  /* 2. A name shared by waters in different counties: ask, do not guess. Then a tap runs the search. */
  for (const [s, labels] of [['deer near blue lake', ['Blue Lake, Tooele Co.', 'Blue Lake, Sanpete Co.']], ['elk near silver lake', ['Silver Lake (American Fork Canyon), Utah Co.', 'Silver Lake (Big Cottonwood Canyon), Salt Lake Co.']]]) {
    const a = answer(s);
    const chips = [...a.html.matchAll(/data-fask="wplace" data-fval="([^"]*)">([^<]*)</g)];
    ok(`"${s}": no place guessed, a "Which one?" row of chips, one per place, named with the county, and no results`,
      !a.q.place && a.which && !a.asks && a.rows === 0 && same(chips.map(m => m[2].replace(/&amp;/g, '&')).sort(), labels.slice().sort()), JSON.stringify({ place: a.q.place, which: a.which, chips: chips.map(m => m[2]) }));
    const pick = chips.find(m => m[2] === labels[1]);
    click(P, { fask: 'wplace', fval: pick ? pick[1] : '' });
    const q = P.box.T_fq().parsed, html = P.box.vFind();
    ok(`"${s}": tapping "${labels[1]}" runs the search with that place`, q.place && q.place.kind === 'water' && q.place.label === labels[1] && !q.waterPick && !/Which one\?/.test(html) && html.indexOf('Units at one point on ' + labels[1]) >= 0, JSON.stringify({ place: q.place && q.place.label }));
  }
  /* 3. Rivers, creeks and streams: today's Where? chips with one line above them. */
  for (const s of ['deer near jordan river', 'elk near weber river', 'deer near currant creek', 'pronghorn by the green river']) {
    const a = answer(s);
    const at = a.txt.indexOf(RIVER), wh = a.txt.indexOf('Where?');
    ok(`"${s}": no place, the river line, then the Where? chips`, !a.q.place && a.asks && at >= 0 && wh > at && /data-fask="place" data-fval="gps"/.test(a.html) && !a.which && a.rows === 0, JSON.stringify({ place: a.q.place, asks: a.asks, line: at >= 0 }));
  }
  {
    const a = answer('deer near gooseberry reservoir tributaries');
    ok('"deer near gooseberry reservoir tributaries" (a stream entry): the river line, Where?', !a.q.place && a.asks && a.txt.indexOf(RIVER) >= 0, a.txt.slice(0, 160));
  }
  /* 4. A still water with no point in the data: the no-point line above Where?. */
  for (const s of ['deer near manning meadows reservoir', 'elk near mountain dell reservoir']) {
    const a = answer(s);
    ok(`"${s}": no place, the no-map-point line, then the Where? chips`, !a.q.place && a.asks && a.txt.indexOf(NOPOINT) >= 0 && a.txt.indexOf('Where?') > a.txt.indexOf(NOPOINT), a.txt.slice(0, 200));
  }
  /* Waters too big for one point: Lake Powell's point is not on the lake and misses most of the units its shore
     touches, Flaming Gorge's point is in Wyoming. No point is ever used; the Where? chips come with one line. */
  for (const [s, label] of [['deer near lake powell', 'Lake Powell, Kane Co.'], ['elk near flaming gorge reservoir', 'Flaming Gorge Reservoir, Daggett Co.'], ['pronghorn hunting at lake powell', 'Lake Powell, Kane Co.']]) {
    const a = answer(s);
    const line = label + ' touches many hunt units. Pick a place, name a unit, or use Where I am now.';
    ok(`"${s}": no point is used; the line "${label} touches many hunt units..." then the Where? chips`,
      !a.q.place && a.asks && a.rows === 0 && a.txt.indexOf(line) >= 0 && a.txt.indexOf('Where?') > a.txt.indexOf(line) && a.txt.indexOf('Units at one point') < 0 && !a.which, a.txt.slice(0, 220));
  }
  ok('no water can reach the old "map point is under no hunt unit" wording (the only still water whose point is under no unit was Flaming Gorge)', (() => {
    const bad = []; const sp = require('vm').runInContext('fStillPlace', P.box);
    for (const pl of DATA.places.places) if (sp(pl) && P.box.unitsAt(pl.lon, pl.lat).length === 0) bad.push(pl.n);
    return bad.every(n => n === 'Flaming Gorge Reservoir');
  })(), 'a still water with a point under no unit');
  /* Everyday phrases: a water name right after a, an, the, some, any, this or that is not resolved. The screen is
     the plain Where? one the old code drew (compared byte for byte with the old finder in the round 2 note). */
  for (const s of ['deer near a little reservoir', 'elk near the town reservoir', 'deer by a big lake', 'elk near a willow pond', 'deer near the kids pond', 'deer near some hidden lake', 'elk near this pine lake', 'deer near the fish lake']) {
    const a = answer(s);
    ok(`"${s}": not resolved; plain Where?, no water place, no pick, no water line`, !a.q.place && !a.q.waterPick && !a.q.waterNote && a.asks && !a.which && a.txt.indexOf('Units at one point') < 0 && a.txt.indexOf('touches many') < 0 && a.txt.indexOf(RIVER) < 0 && a.txt.indexOf(NOPOINT) < 0, JSON.stringify({ place: a.q.place, note: a.q.waterNote }));
  }
  {
    const a = answer('deer near fish lake');
    ok('...and "deer near fish lake" (no article) still resolves to Fish Lake', a.q.place && a.q.place.label === 'Fish Lake, Sevier Co.' && a.rows === 8, JSON.stringify(a.q.place));
    const r = answer('deer near the weber river');
    ok('...a river after "the" still gets its river line (it resolves nothing)', !r.q.place && r.txt.indexOf(RIVER) >= 0, r.txt.slice(0, 160));
  }
  /* A mountain tagged as a lake in the data is not a lake. */
  for (const s of ['elk near thousand lake mountain', 'elk near tushar mountain lakes', 'elk near monroe mountain lakes', 'deer near willard peak pond']) {
    const a = answer(s);
    ok(`"${s}": never the lake sentence`, !(a.q.place && a.q.place.kind === 'water') && a.txt.indexOf('Units at one point') < 0, JSON.stringify(a.q.place));
  }
  for (const [s, label] of [['deer near yuba reservoir', 'Yuba Reservoir & State Park, Sanpete Co.'], ['deer near palisade reservoir', 'Palisade Reservoir & State Park, Sanpete Co.'], ['deer near blanding reservoir no 4', 'Blanding Reservoir No. 4, San Juan Co.']]) {
    const a = answer(s);
    ok(`"${s}": real reservoirs whose names end "& State Park" or "No. 4" still resolve`, a.q.place && a.q.place.kind === 'water' && a.q.place.label === label, JSON.stringify(a.q.place));
  }
  /* A unit name that is only a piece of a still water's name: the water wins (when its point is not under that unit). */
  for (const [s, label, unit, oldUnit] of [['deer near joes valley reservoir', 'Joes Valley Reservoir, Emery Co.', 'Manti', 'Valley Mtns'], ['elk near nine mile reservoir', 'Nine Mile Reservoir, Sanpete Co.', 'Nebo', 'Nine Mile'],
      ['deer near beaver dam reservoir', 'Beaver Dam Reservoir, Wayne Co.', 'Plateau', 'Beaver'], ['deer near deer valley ponds', 'Deer Valley Ponds, Summit Co.', 'Wasatch Mtns', 'Valley Mtns'], ['deer near deer valley lakes', 'Deer Valley Ponds, Summit Co.', 'Wasatch Mtns', 'Valley Mtns']]) {
    const a = answer(s);
    ok(`"${s}": the water wins over the unit ${oldUnit} that sits inside its name: ${label}, units include ${unit}, caution sentence`,
      a.q.place && a.q.place.kind === 'water' && a.q.place.label === label && a.units.some(u => u.split(',')[0] === unit) && a.units.indexOf(oldUnit) < 0 && a.txt.indexOf(CAUTION(label)) >= 0, JSON.stringify({ place: a.q.place && a.q.place.label, units: a.units }));
  }
  {
    const a = answer('deer manti near joes valley reservoir');
    ok('"deer manti near joes valley reservoir": a unit named beside the water still wins', a.q.place && a.q.place.kind === 'unit' && a.q.place.label === 'Manti', JSON.stringify(a.q.place));
    for (const sen of ['elk near the joes valley reservoir', 'deer near the nine mile reservoir', 'deer near the beaver dam reservoir', 'elk at the deer valley ponds']) {
      const b = answer(sen);
      ok(`"${sen}": after "the" the water is not used as a spot, and the unit inside its name does not win either: the plain Where? screen, no rows`, !b.q.place && !b.q.waterNote && !b.q.waterPick && b.asks && b.rows === 0 && b.txt.indexOf('Units at one point') < 0, JSON.stringify(b.q.place));
    }
    const c = P.type('deer valley ponds');
    ok('"deer valley ponds" alone: no species read out of the water\'s name; it is a fishing question about the water', c.run === 'fish' && c.tab === 'fish' && c.water === 'deer valley ponds', show(c));
    const d = answer('elk deer valley ponds');
    ok('"elk deer valley ponds": elk is the animal, the water is the place', d.q.sp === 'elk' && d.q.place && d.q.place.label === 'Deer Valley Ponds, Summit Co.', JSON.stringify({ sp: d.q.sp, place: d.q.place }));
    const e = answer('elk near joes valley reservoir');
    ok('"elk near joes valley reservoir" has rows from the Manti units, not Valley Mtns', e.units.indexOf('Manti') >= 0 && e.units.indexOf('Valley Mtns') < 0 && !e.asks, JSON.stringify(e.units));
  }
  for (const [sen, unit] of [['deer near wasatch mtn state park pond', 'Wasatch Mtns'], ['elk near monroe mountain lakes', 'Monroe'], ['deer near wasatch mountain', 'Wasatch Mtns']]) {
    const b = answer(sen);
    ok(`"${sen}": an area name (mountain/mtn in it) never blocks the unit named in it: unit ${unit}, as before`, b.q.place && b.q.place.kind === 'unit' && b.q.place.label === unit, JSON.stringify(b.q.place));
  }
  for (const [sen, unit] of [['deer near pine valley', 'Pine Valley'], ['elk near east canyon', 'East Canyon'], ['deer near nine mile', 'Nine Mile'], ['deer near san juan', 'San Juan']]) {
    const b = answer(sen);
    ok(`"${sen}": a short water name that is exactly a unit's name is the unit named outright, as before`, b.q.place && b.q.place.kind === 'unit' && b.q.place.label === unit, JSON.stringify(b.q.place));
  }
  for (const sen of ['deer near joes valley', 'deer near beaver dam', 'elk near deer valley']) {
    const b = answer(sen);
    ok(`"${sen}": a short water name that only CONTAINS a unit's name is not the unit: plain Where?, no rows`, !b.q.place && b.asks && b.rows === 0, JSON.stringify(b.q.place));
  }
  for (const sen of ['deer near grandaddy lake', 'deer near upper kents lake', 'elk near whitney reservoir']) {
    const b = answer(sen);
    ok(`"${sen}": a lake or reservoir short name is never given the river line`, b.txt.indexOf(RIVER) < 0, b.txt.slice(0, 120));
  }
  /* Round 4: a unit name that CONTAINS a water name is a unit named outright; compare spans. */
  for (const [sen, label] of [['pronghorn panguitch lake/zion', 'Panguitch Lake/Zion'], ['deer panguitch lake/zion', 'Panguitch Lake/Zion'], ['elk san juan bull elk', 'San Juan Bull Elk'], ['archery deer utah lake extended archery area', 'Utah Lake Extended Archery Area']]) {
    const b = answer(sen);
    ok(`"${sen}": the longer unit name around the water's words wins: unit ${label}, no water spot`, b.q.place && b.q.place.kind === 'unit' && b.q.place.label === label && b.txt.indexOf('Units at one point') < 0, JSON.stringify(b.q.place));
  }
  {
    const q = P.box.fParse('deer valley mtns');
    ok('"deer valley mtns" typed in Find a hunt: the unit Valley Mtns, which straddles the short water name "deer valley"', q.place && q.place.kind === 'unit' && q.place.label === 'Valley Mtns', JSON.stringify(q.place));
  }
  {
    /* Every unit name in the data that strictly contains a known water name (full or short): the unit wins. */
    const vmx = require('vm'), fullN = vmx.runInContext('(fWaterNames(), fNames.concat(fShort))', P.box).map(x => x[0].trim()).filter(x => x.length >= 5 && x.indexOf(' ') > 0);   // the names the parser matches: full names and two-word short names
    const words = x => ' ' + x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    const bases = [...new Set(DATA.units.map(u => u.n.split(',')[0]))];
    const bad = []; let checked = 0;
    for (const u of bases) {
      const uw = words(u);
      if (!fullN.some(w => w !== uw.trim() && uw.indexOf(' ' + w + ' ') >= 0)) continue;
      checked++;
      for (const sp of ['deer', 'elk', 'pronghorn']) { const q = answer(sp + ' ' + u.toLowerCase()).q; if (!(q.place && q.place.kind === 'unit' && words(q.place.label).indexOf(uw.trim()) >= 0)) bad.push(sp + ' ' + u + ' -> ' + JSON.stringify(q.place && q.place.label)); }
    }
    ok(`every unit name that contains a water name (${checked} units) is a unit named outright for deer, elk and pronghorn`, checked > 0 && bad.length === 0, bad.slice(0, 5).join('; '));
  }
  /* "unit" or "units" straight after the name means the unit, with or without an article. */
  for (const sen of ['elk in the panguitch lake unit', 'elk in panguitch lake unit', 'deer near the panguitch lake units', 'elk panguitch lake unit']) {
    const b = answer(sen);
    ok(`"${sen}": the word "unit" after the name means the unit Panguitch Lake`, b.q.place && b.q.place.kind === 'unit' && b.q.place.label === 'Panguitch Lake', JSON.stringify(b.q.place));
  }
  {
    const b = answer('elk in the panguitch lake unit');
    ok('"elk in the panguitch lake unit": the old answer, 10 rows', b.rows === 10, 'rows=' + b.rows);
    /* "unit" after a water's name does not make a FRAGMENT of that name the unit ("valley" in "joes valley reservoir"): the answer is the one the same sentence gives without "unit". */
    const c = answer('elk in the joes valley reservoir unit'), c0 = answer('elk in the joes valley reservoir');
    ok('"elk in the joes valley reservoir unit": no unit is picked from a fragment of the water\'s name (not Valley Mtns); after "the" it is the plain Where? screen, no rows', !c.q.place && !c.q.waterNote && !c.q.waterPick && c.asks && c.rows === 0 && c.units.indexOf('Valley Mtns') < 0 && c.txt.indexOf('Units at one point') < 0, JSON.stringify(c.q.place));
    ok('"elk in the joes valley reservoir unit" answers exactly as it does without the word "unit"', same(c.q.place, c0.q.place) && c.asks === c0.asks && c.rows === c0.rows, JSON.stringify([c.q.place, c0.q.place]));
    const d = answer('elk joes valley reservoir unit'), d0 = answer('elk joes valley reservoir');
    ok('"elk joes valley reservoir unit": the water is the place (Joes Valley Reservoir, units at its point, the one-point caution), not Valley Mtns', d.q.place && d.q.place.kind === 'water' && d.q.place.label === 'Joes Valley Reservoir, Emery Co.' && d.units.indexOf('Valley Mtns') < 0 && d.units.indexOf('Manti') >= 0 && d.txt.indexOf(CAUTION('Joes Valley Reservoir, Emery Co.')) >= 0, JSON.stringify(d.q.place));
    ok('"elk joes valley reservoir unit" answers exactly as it does without the word "unit"', same(d.q.place, d0.q.place) && d.rows === d0.rows, JSON.stringify([d.q.place, d0.q.place]));
    for (const sen of ['elk diamond fork unit', 'elk joes valley unit']) {      // short names: no unit from a fragment; the same answer as for the name alone
      const b = answer(sen), b0 = answer(sen.replace(/ unit$/, ''));
      ok(`"${sen}": no unit is picked from a fragment of the water's name (not Diamond Mtn, not Valley Mtns); the same as without "unit"`, !b.q.place && same(b.q.place, b0.q.place) && b.q.waterNote === b0.q.waterNote && b.asks && b.rows === 0, JSON.stringify(b.q.place));
    }
    /* No animal typed: read the sentence itself (fParse), as the Menu does before it decides which finder to open. */
    for (const sen of ['diamond fork unit', 'joes valley unit']) {
      const b = P.box.fParse(sen), b0 = P.box.fParse(sen.replace(/ unit$/, ''));
      ok(`"${sen}" (no animal): no unit is picked from a fragment of the water's name, the same as without "unit"`, !b.place && same(b.place, b0.place) && b.waterNote === b0.waterNote && b.alsoWater === b0.alsoWater, JSON.stringify(b.place));
    }
    {
      const b = answer('elk diamond fork unit');
      ok('"elk diamond fork unit": the river line and Where?, no rows', !b.q.place && b.q.waterNote === 'river' && b.asks && b.rows === 0 && b.txt.indexOf(RIVER) >= 0, JSON.stringify([b.q.place, b.q.waterNote]));
    }
    /* Two waters in one sentence: a unit name inside the words of EITHER water is that water, not the unit. The place is the water the parser keeps (Strawberry Reservoir, a full name), as it is without the other water. */
    for (const sen of ['elk diamond fork near strawberry reservoir', 'elk strawberry reservoir near diamond fork', 'deer near diamond fork and strawberry reservoir']) {
      const b = answer(sen), sp = sen.split(' ')[0];
      ok(`"${sen}": ${sp}, the place is the water Strawberry Reservoir, not a unit (no Diamond Mtn from the fragment "diamond")`, b.q.sp === sp && b.q.place && b.q.place.kind === 'water' && b.q.place.label === 'Strawberry Reservoir, Wasatch Co.' && b.units.indexOf('Diamond Mtn') < 0, JSON.stringify([b.q.sp, b.q.place]));
    }
    {
      const b = answer('elk diamond fork near strawberry reservoir'), b0 = answer('elk near strawberry reservoir');
      ok('"elk diamond fork near strawberry reservoir" answers exactly as "elk near strawberry reservoir" does', same(b.q.place, b0.q.place) && b.rows === b0.rows && b.asks === b0.asks, JSON.stringify([b.q.place, b0.q.place]));
    }
    /* What must not change. */
    {
      const q = P.box.fParse('elk diamond fork');
      ok('"elk diamond fork" alone: elk, no place, the river note, as before', q.sp === 'elk' && !q.place && q.waterNote === 'river', JSON.stringify([q.sp, q.place, q.waterNote]));
      for (const sen of ['elk diamond mtn', 'elk diamond mountain']) {
        const b = P.box.fParse(sen);
        ok(`"${sen}": the unit Diamond Mtn, as before`, b.place && b.place.kind === 'unit' && b.place.label === 'Diamond Mtn', JSON.stringify(b.place));
      }
      const g = P.box.fParse('tushar mountain goat');
      ok('"tushar mountain goat": the animal is mountain goat, as before', g.sp === 'mountain goat', JSON.stringify(g.sp));
      const pv = P.box.fParse('deer pine valley');
      ok('"deer pine valley": the Pine Valley unit (a short name that is exactly a unit\'s name), as before', pv.place && pv.place.kind === 'unit' && pv.place.label === 'Pine Valley', JSON.stringify(pv.place));
      const pl = P.box.fParse('the panguitch lake unit');
      ok('"the panguitch lake unit": the unit Panguitch Lake, as before', pl.place && pl.place.kind === 'unit' && pl.place.label === 'Panguitch Lake', JSON.stringify(pl.place));
    }
    /* A river whose name holds a unit's name stays consistent with the water's point, but is still silent about the unit: it is the river, not the unit Ogden. */
    for (const sen of ['ogden river unit', 'elk ogden river unit']) {
      const b = answer(sen), b0 = answer(sen.replace(/ unit$/, ''));
      ok(`"${sen}": the river answer, not the unit Ogden, and the same as without "unit"`, !(b.q.place && b.q.place.kind === 'unit') && same(b.q.place, b0.q.place) && b.q.waterNote === b0.q.waterNote && b.r.run === b0.r.run, JSON.stringify([b.q.place, b.q.waterNote, b.r.run]));
    }
    for (const sen of ['elk in the beaver dam reservoir unit', 'deer near the deer valley unit', 'elk nine mile reservoir unit']) {
      const b = answer(sen);
      ok(`"${sen}": no unit is picked from a fragment of the water's name`, !(b.q.place && b.q.place.kind === 'unit'), JSON.stringify(b.q.place));
    }
    /* The name IS the unit's name: the unit, as before. */
    for (const [sen, label] of [['elk nine mile unit', 'Nine Mile'], ['elk east canyon unit', 'East Canyon'], ['deer pine valley unit', 'Pine Valley'], ['elk san juan unit', 'San Juan'], ['deer escalante unit', 'Escalante'], ['elk panguitch lake unit', 'Panguitch Lake'], ['deer near the panguitch lake units', 'Panguitch Lake']]) {
      const b = answer(sen);
      ok(`"${sen}": the water's name is the unit's name, so "unit" means the unit ${label}`, b.q.place && b.q.place.kind === 'unit' && b.q.place.label === label, JSON.stringify(b.q.place));
    }
  }
  /* Round 3 item 4: a still water the name check keeps out, but which has a point, gets the plain Where? screen, no "no map point" line. */
  for (const sen of ['deer near willard peak pond', 'elk near tushar mountain lakes']) {
    const b = answer(sen);
    ok(`"${sen}": has a point but is kept out by the name check: plain Where?, no line at all`, !b.q.place && b.asks && !b.q.waterNote && b.txt.indexOf(NOPOINT) < 0 && b.txt.indexOf(RIVER) < 0 && b.txt.indexOf('Units at one point') < 0, JSON.stringify(b.q.waterNote));
  }
  /* "Where I am now" in Find a hunt asks the phone and answers from it; a refusal is said in the app's own words. */
  {
    const calls = [];
    P.box.navigator.geolocation = { getCurrentPosition(okFn, errFn) { calls.push({ okFn, errFn }); } };
    answer('deer near a big lake');
    click(P, { fask: 'place', fval: 'gps' });
    ok('"Where I am now": the phone is asked for its location, and the screen says it is getting a fix', calls.length === 1 && P.box.T_fq().parsed.place.kind === 'gps' && /Getting a GPS fix/.test(P.box.vFind()), 'calls=' + calls.length);
    calls[0].okFn({ coords: { latitude: 38.5481, longitude: -111.70987 } });
    const q = P.box.T_fq().parsed, html = P.box.vFind();
    ok('...and when the fix arrives it answers from it: the Fish Lake units, deer rows, no Where?', q.place.lat === 38.5481 && (html.match(/class="row"/g) || []).length === 8 && !/<div class="sec-title">Where\?</.test(html) && html.indexOf('Hunt boundaries under that spot: <b>Fishlake') >= 0, JSON.stringify(q.place));
    answer('deer near a big lake');
    click(P, { fask: 'place', fval: 'gps' });
    calls[1].errFn({ code: 1, message: 'User denied Geolocation' });
    const t = text(P.box.vFind());
    ok('...a refusal is said in words and the Where? chips come back', t.indexOf('No GPS fix: User denied Geolocation. Allow location for this app in the phone settings and try again.') >= 0 && t.indexOf('Where?') > 0 && !P.box.T_fq().parsed.place, t.slice(0, 200));
    click(P, { fask: 'place', fval: 'heber' });
    ok('...and picking a home afterwards clears the message', !/No GPS fix/.test(P.box.vFind()) && P.box.T_fq().parsed.place.kind === 'home', '');
    P.box.navigator.geolocation = { getCurrentPosition(okFn, errFn) { calls.push({ okFn, errFn }); } };
    P.box.fRun('chukar where I am'); calls[calls.length - 1].errFn({ code: 1, message: 'User denied Geolocation' });
    ok('"chukar where I am" with location refused shows the same refusal message as the big-game path, above the bird list', text(P.box.vFind()).indexOf('No GPS fix: User denied Geolocation. Allow location for this app in the phone settings and try again.') >= 0 && P.box.T_fq().parsed.bird[0] === 'chukar', text(P.box.vFind()).slice(0, 160));
    P.box.fRun('chukar where I am'); calls[calls.length - 1].errFn({ code: 3 });
    ok('...and a timeout shows "No GPS fix yet. Try again in the open." there too', text(P.box.vFind()).indexOf('No GPS fix yet. Try again in the open.') >= 0, '');
    answer('deer near a big lake');
    P.box.navigator.geolocation = undefined;
    click(P, { fask: 'place', fval: 'gps' });
    ok('...a phone with no location service says so', text(P.box.vFind()).indexOf('This phone is not sharing location with the app.') >= 0, text(P.box.vFind()).slice(0, 160));
    answer('deer near me right now');
    P.box.navigator.geolocation = { getCurrentPosition(okFn, errFn) { calls.push({ okFn, errFn }); } };
    P.box.fRun('deer near me right now'); calls[calls.length - 1].errFn({ code: 1 });
    ok('a sentence with "right now" that is refused is told so, not left silent', /No GPS fix: location was refused\. Allow location/.test(text(P.box.vFind())), text(P.box.vFind()).slice(0, 160));
    P.box.fRun('deer near me right now'); calls[calls.length - 1].errFn({ code: 3, message: 'Timeout expired' });
    ok('a timeout says "No GPS fix yet. Try again in the open." and not the allow-location wording', /No GPS fix yet\. Try again in the open\./.test(text(P.box.vFind())) && !/Allow location/.test(text(P.box.vFind())), text(P.box.vFind()).slice(0, 200));
    P.box.fRun('deer near me right now'); calls[calls.length - 1].errFn({});
    ok('an error with no code and no message is also not called a refusal', /No GPS fix yet\. Try again in the open\./.test(text(P.box.vFind())), '');
    P.box.navigator.geolocation = { getCurrentPosition() {} };
  }
  /* 5. Ordinary words and everything that already had a place: unchanged. */
  for (const s of ['deer near the lake', 'elk by the lake', 'deer near a creek', 'deer near the river', 'deer near the reservoir', 'elk near a pond', 'elk', 'deer season']) {
    const a = answer(s);
    ok(`"${s}" is unchanged: no place, no water line, no "Which one?", plain Where?`, !a.q.place && !a.q.waterNote && !a.q.waterPick && a.asks && !a.which && a.txt.indexOf(RIVER) < 0 && a.txt.indexOf(NOPOINT) < 0 && a.txt.indexOf('Units at one point') < 0, JSON.stringify({ place: a.q.place, note: a.q.waterNote }));
  }
  {
    const a = answer('elk by the cabin');
    ok('"elk by the cabin" is unchanged: home Heber City, rows', a.q.place && a.q.place.kind === 'home' && a.q.place.label === 'Heber City' && a.rows > 0 && a.txt.indexOf('Units at one point') < 0, JSON.stringify(a.q.place));
  }
  for (const s of ['elk fishlake', 'deer near fishlake', 'deer fishlake']) {
    const b = answer(s);
    ok(`"${s}" is unchanged: home Torrey ("fishlake" is Pete's own word), both Fishlake units offered as the switch, no water spot, no caution line`,
      b.q.place && b.q.place.kind === 'home' && b.q.place.label === 'Torrey' && !b.q.waterPick && !b.q.waterNote &&
      same((b.q.alsoUnit || []).map(u => u.label), ['Fishlake', 'Fishlake/Thousand Lakes']) && b.txt.indexOf('Units at one point') < 0, show(b.r));
  }
  /* A unit named inside a water's own name is the water. Round 3: this is literal, still or flowing, full or short name. */
  for (const [sen, label] of [['deer near panguitch lake', 'Panguitch Lake, Garfield Co.'], ['deer near pine valley reservoir', 'Pine Valley Reservoir, Washington Co.'], ['elk near east canyon reservoir', 'East Canyon Reservoir, Morgan Co.']]) {
    const b = answer(sen);
    ok(`"${sen}": the unit name inside the water's name does not win; the water's point does (${label}), with the caution sentence`, b.q.place && b.q.place.kind === 'water' && b.q.place.label === label && b.txt.indexOf(CAUTION(label)) >= 0 && b.rows > 0, JSON.stringify(b.q.place));
  }
  for (const [sen, units] of [['deer near san juan river', 'San Juan'], ['elk near ogden river', 'Ogden'], ['deer near escalante river', 'Escalante'], ['deer near beaver creek', 'Beaver'], ['elk near lower beaver river', 'Beaver']]) {
    const b = answer(sen);
    ok(`"${sen}": a river with the unit ${units} inside its name gets the river line and the Where? chips, not the unit`, !b.q.place && b.asks && b.txt.indexOf(RIVER) >= 0 && b.rows === 0, JSON.stringify(b.q.place));
  }
  for (const sen of ['elk near diamond fork', 'elk in diamond fork canyon', 'deer near diamond fork river']) {
    const b = answer(sen);
    ok(`"${sen}": not Diamond Mtn (Uintah): the river line and the Where? chips`, !b.q.place && b.asks && b.txt.indexOf(RIVER) >= 0 && b.rows === 0, JSON.stringify(b.q.place));
  }
  {
    const b = answer('pronghorn near panguitch lake');
    ok('"pronghorn near panguitch lake" answers from the lake\'s point and shows its pronghorn hunts (Panguitch Lake/Zion North), not "Nothing matched"', b.q.place && b.q.place.kind === 'water' && b.units.some(u => /Zion, North/.test(u)) && b.rows > 0 && !b.nothing, JSON.stringify({ units: b.units, rows: b.rows }));
    ok('a unit outside the water\'s words still wins: "deer manti near the san juan river" is Manti', answer('deer manti near the san juan river').q.place.label === 'Manti', '');
  }
  /* A sentence that already gave a place keeps it: a water beside a home word does not replace the home. */
  {
    const b = answer('deer near torrey and fish lake');
    ok('"deer near torrey and fish lake": the home word wins, as before', b.q.place && b.q.place.kind === 'home' && b.q.place.label === 'Torrey', JSON.stringify(b.q.place));
  }
  /* Short ways of saying a water, towns and county phrases are not matched to a pond. */
  for (const s of ['deer near duck fork', 'deer in carbon county', 'carbon county deer', 'elk near skyline drive', 'deer near syracuse', 'elk near garden city', 'deer near utah county']) {
    const b = answer(s);
    ok(`"${s}" does not become a water spot`, !(b.q.place && b.q.place.kind === 'water') && !b.q.waterPick && b.txt.indexOf('Units at one point') < 0, JSON.stringify(b.q.place));
  }
  /* A hunting property or a range that holds a water word gets no line. */
  for (const s of ['deer near stewart lake wma', 'elk in the uinta mountains']) {
    const b = answer(s);
    ok(`"${s}": no water line (a hunting property or a range is not a river or a missing water)`, !b.q.waterNote && b.txt.indexOf(RIVER) < 0 && b.txt.indexOf(NOPOINT) < 0, b.txt.slice(0, 160));
  }
  /* Birds: not changed by this build (they list access points; a lake's single point is not used for them). */
  for (const s of ['pheasant near fish lake', 'ducks near fish lake']) {
    const b = answer(s);
    ok(`"${s}" is unchanged: no water spot`, b.q.place == null && !b.q.waterPick && !b.q.waterNote && b.txt.indexOf('Units at one point') < 0, JSON.stringify(b.q.place));
  }
  /* Fishing is still fishing, and "hunt near fish lake" still asks what to hunt. */
  for (const s of ['fish lake', 'fish lake rules', 'trout at fish lake', 'fishing at fish lake', 'deer creek reservoir rules', 'i want to go fishing']) {
    const r = P.type(s);
    ok(`"${s}" still goes to the Fish screen`, r.tab === 'fish' && r.run !== 'hunt', show(r));
  }
  {
    const a = answer('hunt near fish lake');
    ok('"hunt near fish lake" still asks what to hunt', !a.q.sp && /What do you want to hunt\?/.test(a.html), a.txt.slice(0, 140));
    click(P, { fask: 'sp', fval: 'deer' });
    const q = P.box.T_fq().parsed, html = P.box.vFind();
    ok('...and after the animal is tapped, the lake becomes the place and the deer answer is drawn', q.place && q.place.label === 'Fish Lake, Sevier Co.' && (html.match(/class="row"/g) || []).length === 8 && !/<div class="sec-title">Where\?</.test(html), JSON.stringify({ place: q.place && q.place.label }));
    const b = answer('hunt near weber river');
    click(P, { fask: 'sp', fval: 'elk' });
    ok('...a river with the animal tapped later gets the river line', !P.box.T_fq().parsed.place && text(P.box.vFind()).indexOf(RIVER) >= 0, '');
  }
}

/* ---- Every screen word and every screen's name, alone, opens its screen and searches nothing. */
for (const d of P.box.T_go.GO_DEST) {
  const words = [...(d.keys || []), ...(d.weak || []), d.title];
  for (const w of words) {
    const r = P.type(w);
    const where = d.act ? 'today' : d.tab;
    ok(`"${w}" alone opens ${d.id}`, r.tab === where && r.run === 'none' && (!d.mode || r.mode === d.mode), show(r));
  }
}

/* ---- Nothing typed, nothing but punctuation, or far too much: never a crash. */
for (const [name, text] of [['empty', ''], ['spaces', '   '], ['punctuation', '?!.,;:'], ['5,000 characters', ('trout deer near fish lake wma draw odds ').repeat(125).slice(0, 5000)]]) {
  let threw = null;
  try { P.type(text); } catch (e) { threw = e.message; }
  ok(`${name} input does not throw`, threw === null, threw);
}

/* ---- The first run with no signal: the fishing rules have not arrived, so no
        water's name is known, and the animal still decides. */
{
  const Q = page(false);
  hunt('deer near fish lake', 'deer', Q);
  hunt('deer near antelope island', 'deer', Q);
  screen('deer cams', 'cams', null, Q);
  screen('i want to go fishing', 'fish', null, Q);
  for (const s of ['fishing at elk lake', 'ice fishing at goose lake', 'fishing at sheep creek lake', 'fishing at duck fork']) {
    fishTab(s, Q);
    const h = Q.box.fParse(s);                        // the hunt finder, if the sentence is typed there
    ok(`hunt finder, no rules yet: "${s}" is left to fishing`, !!h.fish && !h.sp && !h.bird, JSON.stringify({ sp: h.sp, bird: h.bird && h.bird[0], fish: !!h.fish }));
  }
  hunt('elk hunting at fish lake', 'elk', Q);
  screen('angling at duck fork', 'fish', null, Q);    // no screen word and nothing read yet: still Fish
  hunt('deer season', 'deer', Q);
}

/* ---- The tags row lands on the tags, and leaving Contacts ends the landing. */
{
  const G = P.box.T_go, tags = G.GO_DEST.find(d => d.id === 'tags'), contacts = G.GO_DEST.find(d => d.id === 'contacts');
  let jumps = 0;
  P.box.els.lotags = { scrollIntoView() { jumps++; } };
  P.box.LOT = null;                                   // the tag data is still on its way
  P.timers.length = 0;
  G.goOpen(tags, {});
  ok('the tags row scrolls to the tags heading', jumps === 1 && P.box.tab === 'contacts', 'jumps=' + jumps);
  ok('and tries again while the tag data loads', P.timers.length === 1, 'timers=' + P.timers.length);
  G.goOpen(tabOf('map'), {});
  G.goOpen(contacts, {});
  const before = jumps;
  P.timers.splice(0).forEach(t => t.fn());
  ok('leaving and coming back to Contacts does not jump to the tags', P.timers.length === 0 && jumps === before, 'jumps after=' + (jumps - before));
  /* The landing only happens on Contacts. Another row does not land, and if some other
     link moves him off Contacts before the data arrives, the retry does nothing. */
  jumps = 0;
  G.goOpen(contacts, {});
  ok('the Contacts row itself does not land on the tags', jumps === 0 && P.timers.length === 0, 'jumps=' + jumps);
  G.goOpen(tags, {});
  P.box.tab = 'seasons';                              // an in-page link, not the Menu, changed the screen
  P.timers.splice(0).forEach(t => t.fn());
  ok('a retry after the screen has changed does not scroll', jumps === 1, 'jumps=' + jumps);
  delete P.box.els.lotags;
}

/* ---- The home towns. docs/state.js keeps the choice on the phone, site.js draws the Home towns page, and
        app.js draws the header and the drive times. These pages load the real files with the page behind them
        stubbed, and start from the storage a test hands them: no words of the hunter's own, and Salt Lake City
        alone when nothing was ever chosen. A tap is the app's own click handler; the words field losing focus
        is its change handler. */
{
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ANCH = DATA.config.anchors, label = id => ANCH.find(a => a.id === id).label;
  const towns = (list, extra) => Object.assign({ 'ha.anchors': JSON.stringify(list.map(x => typeof x === 'string' ? { id: x } : x)) }, extra || {});
  const app = ls => page(true, null, { app: true, ls: ls || {} });
  const tap = (S, attrs) => {
    const el = { dataset: attrs };
    const ev = { target: { closest: sel => (Object.keys(attrs).some(k => sel.indexOf('[data-' + k + ']') >= 0) ? el : null) } };
    (S.box.LISTENERS.click || []).forEach(fn => fn(ev));
  };
  const typed = (S, id, text) => (S.box.LISTENERS.change || []).forEach(fn => fn({ target: { dataset: { townWords: id }, value: text } }));
  const kept = S => JSON.parse(S.store.get('ha.anchors'));
  const chosen = S => S.box.anchorsChosen().map(a => a.id);
  /* anchorId and anchorLabel are const arrows in state.js: reached by running them in the page. */
  const idOf = S => vm.runInContext('anchorId()', S.box), labelOf = S => vm.runInContext('anchorLabel()', S.box);
  const view = S => S.box.els.view.innerHTML;
  const openTowns = S => { S.box.tab = 'towns'; S.box.render(); return view(S); };
  const header = S => { S.box.render(); return [...S.box.els.homesel.innerHTML.matchAll(/<button data-anchor="([^"]*)" aria-pressed="(true|false)">([^<]*)<\/button>/g)].map(m => ({ id: m[1], code: m[3], on: m[2] === 'true' })); };
  const tiles = html => [...html.matchAll(/<div class="stat"><div class="k">([^<]*)<\/div><div class="v"[^>]*>([^<]*)<\/div><\/div>/g)].map(m => [m[1], m[2]]);
  const THREE = ['slc', 'heber', 'torrey'];

  /* 1. Carry-over from the one home choice that v35 kept in ha.home. */
  for (const [old, want] of [['nsl', 'slc'], ['heber', 'heber'], ['torrey', 'torrey'], ['a value nobody wrote', 'slc'], ['', 'slc']]) {
    const S = app({ 'ha.home': old });
    ok(`carry-over: ha.home "${old}" gives Salt Lake City, Heber City and Torrey in that order, measuring from ${want}`,
      same(kept(S), THREE.map(id => ({ id }))) && S.store.get('ha.anchor') === want && same(chosen(S), THREE) && idOf(S) === want,
      JSON.stringify([S.store.get('ha.anchors'), S.store.get('ha.anchor'), idOf(S)]));
    ok(`carry-over: ha.home "${old}" brings no words, and the old key is left where it was`,
      S.box.anchorsChosen().every(a => a.words.length === 0) && S.store.get('ha.home') === old, JSON.stringify(S.box.anchorsChosen().map(a => a.words)));
  }
  {
    const S = app({ 'ha.home': 'torrey' }), h = header(S);
    ok('carry-over from torrey: the header shows SLC, HC and TOR, and TOR is the one pressed', same(h.map(x => [x.code, x.on]), [['SLC', false], ['HC', false], ['TOR', true]]), JSON.stringify(h));
    const again = app(new Map(S.store).set('ha.home', 'nsl'));
    ok('carry-over runs once: with the choice written, a changed ha.home moves nothing', idOf(again) === 'torrey' && same(chosen(again), THREE) && again.store.get('ha.anchor') === 'torrey', JSON.stringify([idOf(again), chosen(again)]));
    const readers = fs.readdirSync(path.join(ROOT, 'docs')).filter(f => /\.js$/.test(f) && f !== 'state.js' && /ha\.home/.test(fs.readFileSync(D(f), 'utf8')));
    ok('no script except state.js reads the old ha.home key', readers.length === 0, readers.join(', '));
  }
  {
    const S = app({}), h = header(S);
    ok('carry-over: with no old key and no choice nothing is written, and Salt Lake City is the only town',
      !S.store.has('ha.home') && !S.store.has('ha.anchors') && !S.store.has('ha.anchor') && same(chosen(S), ['slc']) && idOf(S) === 'slc' && same(h.map(x => [x.code, x.on]), [['SLC', true]]), JSON.stringify([[...S.store.keys()], chosen(S), h]));
    const own = app({ 'ha.home': 'torrey', 'ha.anchors': JSON.stringify([{ id: 'prv', words: ['the farm'] }]) });
    ok('carry-over: a phone that already chose its towns keeps them, and the old key changes nothing',
      same(kept(own), [{ id: 'prv', words: ['the farm'] }]) && !own.store.has('ha.anchor') && same(chosen(own), ['prv']) && own.box.anchorsChosen()[0].words[0] === 'the farm', JSON.stringify([own.store.get('ha.anchors'), chosen(own)]));
  }

  /* 2. The Home towns page: twelve towns, up to three, in the order tapped, with the hunter's words. */
  {
    const S = app({}), html = openTowns(S);
    const chips = [...html.matchAll(/<button class="chip" data-town="([^"]*)" aria-pressed="(true|false)">([^<]*)<\/button>/g)];
    ok('Home towns: twelve chips, one for each anchor in the data, each named by its label', chips.length === 12 && ANCH.length === 12 && same(chips.map(m => m[1]), ANCH.map(a => a.id)) && same(chips.map(m => m[3]), ANCH.map(a => a.label)), chips.map(m => m[1]).join(','));
    ok('Home towns: with nothing chosen yet Salt Lake City is the one chip pressed', same(chips.filter(m => m[2] === 'true').map(m => m[1]), ['slc']), JSON.stringify(chips.map(m => m[2])));
    ok('Home towns: one words field, for Salt Lake City, asking for "Your words for it (comma separated)"', same([...html.matchAll(/data-town-words="([^"]*)"/g)].map(m => m[1]), ['slc']) && html.indexOf('Your words for it (comma separated)') >= 0, '');
    ok('Home towns: the page says the towns and the words stay on this phone', /towns you choose and your words for them stay on this phone/.test(html), '');
  }
  {
    const S = app({});
    openTowns(S);
    tap(S, { town: 'moab' }); tap(S, { town: 'slc' }); tap(S, { town: 'ogd' }); tap(S, { town: 'prv' });
    ok('Home towns: towns are chosen in the order tapped, and tapping a chosen town takes it off (moab, slc off, ogd, prv)', same(kept(S).map(e => e.id), ['moab', 'ogd', 'prv']) && same(chosen(S), ['moab', 'ogd', 'prv']), S.store.get('ha.anchors'));
    ok('Home towns: the first town chosen is the one the word "home" means', S.box.anchorsChosen()[0].aliases[0] === 'home' && S.box.anchorsChosen().slice(1).every(a => a.aliases.indexOf('home') < 0), JSON.stringify(S.box.anchorsChosen().map(a => a.aliases)));
    ok('Home towns: the page shows a words field for each chosen town, in the order chosen, and marks the first as home', same([...view(S).matchAll(/data-town-words="([^"]*)"/g)].map(m => m[1]), ['moab', 'ogd', 'prv']) && /Moab <span class="note">&middot; home<\/span>/.test(view(S)), '');
    ok('Home towns: the header follows the page and shows the three codes in the order chosen', same(header(S).map(x => x.code), ['MOB', 'OGD', 'PRV']), JSON.stringify(header(S)));
    const before = S.store.get('ha.anchors');
    tap(S, { town: 'stg' });
    ok('Home towns: a fourth town is refused, the saved choice is untouched, and the page says why', S.store.get('ha.anchors') === before && same(chosen(S), ['moab', 'ogd', 'prv']) && /Three towns is the most/.test(view(S)) && !/data-town="stg" aria-pressed="true"/.test(view(S)), view(S).slice(0, 300));
    ok('Home towns: ...and the line is gone on the next redraw', !/Three towns is the most/.test(openTowns(S)), '');

    typed(S, 'ogd', ' The Shop ,  elk camp,, ');
    typed(S, 'moab', 'moab');
    ok('Home towns: words are saved on their own town, split at commas, trimmed, empties dropped, capitals kept', same(kept(S), [{ id: 'moab', words: ['moab'] }, { id: 'ogd', words: ['The Shop', 'elk camp'] }, { id: 'prv', words: [] }]), S.store.get('ha.anchors'));
    ok('Home towns: ...and the page shows them back, and the words are the aliases the finders hear (home only on the first)',
      /data-town-words="ogd" value="The Shop, elk camp"/.test(openTowns(S)) && same(S.box.anchorsChosen().map(a => a.aliases), [['home', 'moab'], ['The Shop', 'elk camp'], []]), JSON.stringify(S.box.anchorsChosen().map(a => a.aliases)));
    typed(S, 'stg', 'nowhere');
    ok('Home towns: words typed for a town that is not chosen are not kept', !/stg/.test(S.store.get('ha.anchors')), S.store.get('ha.anchors'));
    const back = app(S.store);
    ok('Home towns: a page opened later on the same phone reads the same towns, order and words', same(chosen(back), ['moab', 'ogd', 'prv']) && same(back.box.anchorsChosen().map(a => a.words), [['moab'], ['The Shop', 'elk camp'], []]), JSON.stringify(back.box.anchorsChosen().map(a => a.words)));
    ok('Home towns: the words typed reach the finders at once ("elk near the shop" is Ogden, home)', (() => { S.type('elk near the shop'); const q = S.box.T_fq().parsed; return q.place && q.place.kind === 'home' && q.place.id === 'ogd'; })(), JSON.stringify(S.box.T_fq().parsed && S.box.T_fq().parsed.place));
    /* The input event stores words as they are typed, so a phone locked before the field loses focus keeps them. */
    (S.box.LISTENERS.input || []).forEach(fn => fn({ target: { dataset: { townWords: 'prv' }, value: ' river camp, ' } }));
    ok('Home towns: words are stored as they are typed, before the field loses focus', same(kept(S).find(e => e.id === 'prv').words, ['river camp']), S.store.get('ha.anchors'));
    ok('Home towns: the Menu takes "change my home" to the Home towns page', S.type('change my home').tab === 'towns', JSON.stringify(S.type('change my home')));
    ok('Home towns: ...while "elk near home" still goes to the hunt finder', S.type('elk near home').run === 'hunt', JSON.stringify(S.type('elk near home')));
    typed(S, 'prv', '');   // back to no words for Provo, as the checks below expect

    S.box.tab = 'towns';
    tap(S, { anchor: 'ogd' });
    tap(S, { town: 'ogd' });
    ok('Home towns: taking off the town being measured from leaves the rest in order and measures from the first one chosen', same(chosen(S), ['moab', 'prv']) && idOf(S) === 'moab' && !S.store.has('ha.anchor'), JSON.stringify([chosen(S), idOf(S), S.store.get('ha.anchor')]));
    tap(S, { town: 'moab' });
    ok('Home towns: taking a second town off leaves the last one, with its words kept', same(kept(S), [{ id: 'prv', words: [] }]), S.store.get('ha.anchors'));
    tap(S, { town: 'prv' });
    ok('Home towns: the last town cannot be taken off, and the page says one must stay chosen', same(chosen(S), ['prv']) && /Keep one town chosen/.test(view(S)), view(S).slice(0, 300));
  }

  /* 3. The header: the codes from the data, the pressed chip follows ha.anchor, and a tap never reorders the choice. */
  {
    const S = app(towns(THREE, { 'ha.anchor': 'heber' }));
    let h = header(S);
    ok('header: one chip for each chosen town, by its code from the data, in the order chosen', same(h.map(x => x.id), THREE) && same(h.map(x => x.code), THREE.map(id => ANCH.find(a => a.id === id).code)) && same(h.map(x => x.code), ['SLC', 'HC', 'TOR']), JSON.stringify(h));
    ok('header: the pressed chip is the one ha.anchor names', same(h.map(x => x.on), [false, true, false]), JSON.stringify(h));
    const order = S.store.get('ha.anchors');
    tap(S, { anchor: 'torrey' }); h = header(S);
    ok('header: tapping TOR presses TOR and measures from Torrey', same(h.map(x => x.on), [false, false, true]) && S.store.get('ha.anchor') === 'torrey' && idOf(S) === 'torrey' && labelOf(S) === 'Torrey', JSON.stringify(h));
    tap(S, { anchor: 'slc' }); h = header(S);
    ok('header: tapping a chip never reorders ha.anchors, and the chips keep their order', S.store.get('ha.anchors') === order && same(h.map(x => x.id), THREE) && same(h.map(x => x.on), [true, false, false]), S.store.get('ha.anchors'));
    tap(S, { anchor: 'moab' }); h = header(S);
    ok('header: a chip for a town that is not chosen is ignored', S.store.get('ha.anchor') === 'slc' && idOf(S) === 'slc' && S.store.get('ha.anchors') === order, S.store.get('ha.anchor'));
    ok('header: a bad ha.anchor falls back to the first chosen town', (() => { const x = app(towns(['prv', 'moab'], { 'ha.anchor': 'nsl' })); return idOf(x) === 'prv' && header(x)[0].on; })(), '');
    const pc = header(app(towns(['prv', 'prc'])));
    ok('header: Provo and Price get their own codes, not a shared initial', same(pc.map(x => x.code), ['PRV', 'PRC']), JSON.stringify(pc));
  }

  /* 4. A place's minutes come from the measuring town: a fishing place, and a bird point. */
  {
    const S = app(towns(THREE, { 'ha.anchor': 'slc' })), places = DATA.places.places;
    const distinct = p => p.d && new Set(THREE.map(k => p.d[k] && p.d[k].min)).size === 3;
    const plain = places.find(p => distinct(p) && !(p.snap > 0.5)), starred = places.find(p => distinct(p) && p.snap > 0.5);
    ok('data: there are fishing places with three different drive times, with the star and without, to test with', !!plain && !!starred && places.every(p => ANCH.every(a => p.d[a.id] && p.d[a.id].min >= 1)), '');
    for (const id of THREE) {
      tap(S, { anchor: id });
      const a = S.box.fDrive(plain), b = S.box.fDrive(starred);
      ok(`fishing place, header on ${id}: the minutes are that place's d.${id}, starred only where the road stops short`, a.txt === String(plain.d[id].min) && a.sub === 'min' && a.mins === plain.d[id].min && b.txt === String(starred.d[id].min) && b.sub === 'min *', JSON.stringify([a, b]));
      const f = S.box.T_fish(); f.q = ''; f.parsed = null; f.mode = 'near'; S.box.tab = 'fish';
      const html = S.box.T_vFish(), first = /<span class="v">(\d+)<small>/.exec(html);
      ok(`Fish > Near, header on ${id}: "Closest water from ${label(id)}", and the first water is the nearest by d.${id}`, html.indexOf('Closest water from ' + label(id) + ' ') >= 0 && first && +first[1] === Math.min(...places.map(p => p.d[id].min)), (first || [])[1]);
    }
    ok('fishing place sheet: one tile for each chosen town, with that town\'s minutes', same(tiles(S.box.sheetFishPlace(plain)), THREE.map(id => [label(id), plain.d[id].min + 'm'])), JSON.stringify(tiles(S.box.sheetFishPlace(plain))));
    const one = app(towns(['prv']));
    ok('fishing place sheet: a phone with one town chosen gets one tile', same(tiles(one.box.sheetFishPlace(plain)), [['Provo', plain.d.prv.min + 'm']]), JSON.stringify(tiles(one.box.sheetFishPlace(plain))));

    const birds = DATA.birds, withDrive = birds.filter(p => Object.keys(p.drive || {}).length);
    const pick = want => { for (const p of birds.filter(x => x.centroid)) for (const k of THREE) { const d = (p.drive || {})[k]; if (d && !!d.range === want) return [p, k]; } return null; };
    const range = pick(true), exact = pick(false);
    ok('data: a centroid point has a range under one of the three towns and an exact time under another, to test with', !!range && !!exact, '');
    for (const [name, [p, k]] of [['range', range], ['exact', exact]]) {
      tap(S, { anchor: k });
      const d = S.box.drive(p), x = p.drive[k];
      ok(`bird point (${name}), header on ${k}: ${p.name} shows ${x.range ? x.range.join('-') + ' min *' : x.min + ' min'}`,
        x.range ? d.txt === x.range[0] + '-' + x.range[1] && d.sub === 'min *' && d.mins === x.range[0] : d.txt === String(x.min) && d.sub === 'min' && d.mins === x.min, JSON.stringify(d));
    }
    const bad = [];
    for (const id of THREE) {
      tap(S, { anchor: id });
      for (const p of withDrive) {
        const d = S.box.drive(p), x = p.drive[id];
        if (!(x.range ? d.txt === x.range[0] + '-' + x.range[1] && d.sub === 'min *' : d.txt === String(x.min) && d.sub === 'min')) bad.push(p.id + '/' + id);
      }
    }
    ok(`bird points: all ${withDrive.length} that carry drive times show the measuring town's minutes, or its range with the star, for each of the three headers`, withDrive.length > 80 && bad.length === 0, bad.slice(0, 5).join(', '));
    const far = birds.find(p => !Object.keys(p.drive || {}).length && p.lat != null && Math.abs(S.box.miles(ANCH[0].lat, ANCH[0].lon, p.lat, p.lon) - S.box.miles(ANCH.find(a => a.id === 'torrey').lat, ANCH.find(a => a.id === 'torrey').lon, p.lat, p.lon)) > 20);
    ok('data: a bird point with no drive time exists to test the straight-line fallback with', !!far, '');
    for (const id of THREE) {
      tap(S, { anchor: id });
      const a = ANCH.find(x => x.id === id), mi = S.box.miles(a.lat, a.lon, far.lat, far.lon), d = S.box.drive(far);
      ok(`bird point with no drive time, header on ${id}: straight-line miles from ${label(id)}, labelled as miles`, d.txt === mi.toFixed(0) && d.sub === 'mi' && Math.abs(d.mins - mi * 1.4) < 1e-9, JSON.stringify(d));
    }
    const sheet = S.box.sheetPoint(range[0]), t = tiles(sheet);
    ok('bird point sheet: one tile for each chosen town, a range written low-high, then Confidence',
      same(t.slice(0, 3), THREE.map(id => { const x = range[0].drive[id]; return [label(id), (x.range ? x.range[0] + '-' + x.range[1] : x.min) + 'm']; })) && t[3][0] === 'Confidence' && t.length === 4, JSON.stringify(t));
  }

  /* 5. The bird range rule, checked against the baked data. low = round(miles * 60 / 45); a centroid point whose time is at
        least 1.5 times that has an unreliable time, shown as a range low-min; every other pair is a plain, reliable time. */
  {
    const birds = DATA.birds, cents = birds.filter(p => p.centroid), ids12 = ANCH.map(a => a.id);
    ok('centroid: the eight points whose road meets the water at a centre point are flagged in the data',
      same(cents.map(p => p.name).sort(), ['Farmington Bay', 'Farmington Bay WMA', 'Howard Slough WMA', 'Ogden Bay WMA', 'Wallsburg WMA', 'Wallsburg WMA', 'Willard Bay Upland Game Area', 'Willard Spur WMA']) && birds.every(p => p.centroid === undefined || p.centroid === true), cents.map(p => p.name).join(', '));
    const empty = birds.filter(p => !Object.keys(p.drive || {}).length), full = birds.filter(p => Object.keys(p.drive || {}).length);
    ok('birds: the 19 points with no drive time stay without one, and every other point has all twelve towns', empty.length === 19 && full.every(p => same(Object.keys(p.drive), ids12) && Object.values(p.drive).every(d => Number.isInteger(d.min) && d.min >= 1)), `${empty.length} empty`);
    const bad = []; let ranges = 0, exact = 0;
    for (const p of full) for (const [id, d] of Object.entries(p.drive)) {
      const low = Math.round(d.mi * 60 / 45), tag = p.id + '/' + id;
      if (!p.centroid) { if (!(d.reliable === true && d.range === null)) bad.push(tag + ' plain'); continue; }
      if (d.range) { ranges++; if (!(d.reliable === false && d.range[1] === d.min && Math.abs(d.range[0] - low) <= 1 && d.min >= 1.5 * d.range[0])) bad.push(tag + ' range'); }
      else { exact++; if (!(d.reliable === true && d.min < 1.5 * (low + 1))) bad.push(tag + ' exact'); }
    }
    ok('range rule: every point that is not a centroid is reliable with no range', bad.filter(b => / plain$/.test(b)).length === 0, bad.slice(0, 5).join(', '));
    ok('range rule: on a centroid point a time of at least 1.5 times the low end is a range [low, min] with reliable false', ranges > 0 && bad.filter(b => / range$/.test(b)).length === 0, bad.slice(0, 5).join(', '));
    ok('range rule: on a centroid point any other time is reliable, with no range', exact > 0 && bad.filter(b => / exact$/.test(b)).length === 0, bad.slice(0, 5).join(', '));
    const w = birds.find(p => p.id === 'bird-008');
    ok('range rule, one point: Wallsburg WMA (centroid) has a range from Heber City and a plain time from Salt Lake City',
      w.centroid && w.drive.heber.reliable === false && w.drive.heber.range[1] === w.drive.heber.min && w.drive.slc.reliable === true && w.drive.slc.range === null, JSON.stringify([w.drive.heber, w.drive.slc]));
    /* One pair in the data tells the two readings of the miles apart. The file keeps road miles to a tenth, and
       12.4 of them at 45 mph rounds to a low end of 17; the bake takes the low end from OSRM's own metres, before
       they are rounded to a tenth, and that gives 16. If a later bake moves this pair, work the low end out again
       from the unrounded metres before changing the 16: the checks above allow one minute either way. */
    ok('range rule, unrounded miles: Wallsburg WMA from Heber City has a low end of 16, where its stored 12.4 miles would give 17',
      Math.round(w.drive.heber.mi * 60 / 45) === 17 && w.drive.heber.range[0] === 16, JSON.stringify(w.drive.heber));
  }

  /* 6. What the finders hear: "home" is the first chosen town, a town's name is not a word for it, and the
        hunter's own words are. Sentences go in through the Menu, as in the sections above. */
  {
    const N = page(true, null, { ls: towns(THREE) });            // three towns, no words
    N.box.T_hu(load('hunt_units_2026.json')); N.box.ODDS = load('draw_odds.json');
    for (const w of ['provo river', 'logan river', 'price river', 'ogden river']) {
      const r = N.type(w);
      ok(`"${w}" is a water and never a home town: the fishing finder reads that water, with no place`, r.run === 'fish' && r.water === w && N.box.T_fish().parsed.place === null, show(r));
    }
    for (const w of ['trout near salt lake city', 'trout near heber city', 'trout near torrey', 'trout near provo']) {
      const r = N.type(w);
      ok(`"${w}": a town's name is not a word for it, so the fishing finder has no place`, r.run === 'fish' && N.box.T_fish().parsed.place === null, show(r));
    }
    for (const w of ['elk near salt lake city', 'deer near torrey']) {
      const r = N.type(w), q = N.box.T_fq().parsed;
      ok(`"${w}": ...nor for the hunt finder, which asks Where?`, r.run === 'hunt' && q.place === null && /<div class="sec-title">Where\?</.test(N.box.vFind()), show(r));
    }
    for (const w of ['pheasant near heber city', 'chukar near provo']) {
      const r = N.type(w), q = N.box.T_fq().parsed;
      ok(`"${w}": ...nor for the bird list, which has no place to measure from`, r.run === 'hunt' && q.place === null, show(r));
    }
  }
  const byId = Object.fromEntries(DATA.places.places.map(p => [p.id, p]));
  const placeRows = html => [...html.matchAll(/data-fp="([^"]*)"[\s\S]*?<span class="v">(\d+)<small>/g)].map(m => [m[1], +m[2]]);
  for (const [list, head, first] of [[['slc', 'heber', 'torrey'], 'heber', 'slc'], [['torrey', 'slc'], 'slc', 'torrey'], [['moab', 'prv', 'slc'], 'prv', 'moab']]) {
    const H = page(true, null, { ls: towns(list, { 'ha.anchor': head }) });
    const r = H.type('trout near home'), q = H.box.T_fish().parsed, rows = placeRows(r.html);
    ok(`"trout near home" with ${list.join(', ')} chosen and the header on ${head}: home is ${first}, and the list is measured from ${label(first)}`,
      q.place && q.place.kind === 'home' && q.place.id === first && q.place.label === label(first) && r.html.indexOf('from ' + label(first)) >= 0 &&
      rows.length > 3 && rows.every((x, i) => x[1] === byId[x[0]].d[first].min && (i === 0 || rows[i - 1][1] <= x[1])), JSON.stringify(rows.slice(0, 4)));
    const n = H.type('bass'), nq = H.box.T_fish().parsed, nrows = placeRows(n.html);
    ok(`"bass" alone, header on ${head}: no place is named, so the list is measured from the header town ${label(head)}, not from home`,
      nq.place === null && n.html.indexOf('from ' + label(head)) >= 0 && nrows.length > 3 && nrows.every((x, i) => x[1] === byId[x[0]].d[head].min && (i === 0 || nrows[i - 1][1] <= x[1])), JSON.stringify(nrows.slice(0, 4)));
    H.type('elk near home');
    const hq = H.box.T_fq().parsed;
    ok(`"elk near home" is ${label(first)} for the hunt finder too`, hq.place && hq.place.kind === 'home' && hq.place.id === first && hq.place.label === label(first), JSON.stringify(hq.place));
  }
  {
    const C = page(true, null, { ls: towns(['prv', 'moab']) });
    C.box.T_hu(load('hunt_units_2026.json')); C.box.ODDS = load('draw_odds.json');
    C.type('elk');
    const chips = [...C.box.vFind().matchAll(/data-fask="place" data-fval="([^"]*)"/g)].map(m => m[1]);
    ok('Where? lists the chosen towns in order, then "Where I am now"', same(chips, ['prv', 'moab', 'gps']), chips.join(','));
    tap(C, { fask: 'place', fval: 'moab' });
    const pl = C.box.T_fq().parsed.place;
    ok('...and tapping a town makes it the place, under that town\'s own name', pl.kind === 'home' && pl.id === 'moab' && pl.label === 'Moab' && /Moab/.test(C.box.vFind()), JSON.stringify(pl));
    C.type('elk');
    tap(C, { fask: 'place', fval: 'slc' });
    ok('...but a town that is not one of the chosen is not a place: the tap goes to the phone\'s location instead', C.box.T_fq().parsed.place.kind === 'gps', JSON.stringify(C.box.T_fq().parsed.place));
  }
  for (const [list, head, first] of [[['slc', 'heber', 'torrey'], 'torrey', 'slc'], [['torrey', 'slc'], 'slc', 'torrey']]) {
    const B = page(true, null, { ls: towns(list, { 'ha.anchor': head }) });
    const pt = Object.fromEntries(DATA.birds.map(p => [p.id, p])), rowsOf = html => [...html.matchAll(/data-pt="([^"]*)"[\s\S]*?<span class="v">([^<]*)<small>/g)].map(m => [m[1], m[2]]);
    const shown = (p, id) => (d => d.range ? d.range[0] + '-' + d.range[1] : String(d.min))(p.drive[id]);
    for (const [sentence, from] of [['pheasant', head], ['pheasant near home', first]]) {
      B.type(sentence);
      const html = B.box.vFind(), rows = rowsOf(html).filter(r => Object.keys(pt[r[0]].drive || {}).length);
      ok(`bird list, "${sentence}" with ${list.join(', ')} chosen and the header on ${head}: "by drive from ${label(from)}", each place showing that town's time`,
        html.indexOf('by drive from ' + label(from)) >= 0 && rows.length > 3 && rows.every(r => r[1] === shown(pt[r[0]], from)), JSON.stringify(rows.slice(0, 3)));
    }
  }
  {
    const W = page(true, null, { ls: towns([{ id: 'slc', words: ['The Lodge'] }, { id: 'ogd', words: ['ogden', 'the shop'] }, { id: 'moab', words: ['moab', '!!!'] }]) });
    W.box.T_hu(load('hunt_units_2026.json')); W.box.ODDS = load('draw_odds.json');
    for (const [s, id] of [['trout near the lodge', 'slc'], ['trout near THE SHOP', 'ogd'], ['trout near moab', 'moab'], ['trout near home', 'slc']]) {
      W.type(s);
      const pl = W.box.T_fish().parsed.place;
      ok(`the hunter's own words reach the Fish finder: "${s}" is ${id}, in any capitals`, pl && pl.kind === 'home' && pl.id === id, JSON.stringify(pl));
    }
    for (const [s, id] of [['elk near the lodge', 'slc'], ['elk near the shop', 'ogd'], ['elk near home', 'slc']]) {
      W.type(s);
      const pl = W.box.T_fq().parsed.place;
      ok(`...and the hunt finder: "${s}" is ${id}`, pl && pl.kind === 'home' && pl.id === id, JSON.stringify(pl));
    }
    ok('a word with no letters or digits ("!!!") matches nothing, not even a sentence of punctuation', W.box.fParse('?!.,;:').place === null && (W.box.fishParse('?!.,;:', true) || {}).place == null, JSON.stringify(W.box.fParse('?!.,;:').place));
    /* A word that is also the name of a hunt unit: the town wins, and the unit is offered in one tap. */
    const bases = [...new Set(DATA.units.map(u => u.n.split(',')[0]))].filter(b => b.toLowerCase() === 'ogden' || b.toLowerCase().startsWith('ogden '));
    W.type('deer near ogden');
    const q = W.box.T_fq().parsed, html = W.box.vFind();
    ok('"deer near ogden", ogden being the hunter\'s word: the town wins, and the units named Ogden are offered with it',
      q.place.kind === 'home' && q.place.id === 'ogd' && bases.length >= 2 && same(q.alsoUnit.map(u => u.label), bases) && /That is also the name of a hunt unit/.test(html) && html.indexOf('data-fask="useunit" data-fval="Ogden"') >= 0, JSON.stringify(q.alsoUnit && q.alsoUnit.map(u => u.label)));
    tap(W, { fask: 'useunit', fval: 'Ogden' });
    const u = W.box.T_fq().parsed;
    ok('...and one tap switches to the unit Ogden, with the offer gone', u.place.kind === 'unit' && u.place.label === 'Ogden' && u.alsoUnit === null && !/That is also the name of a hunt unit/.test(W.box.vFind()), JSON.stringify(u.place));
    W.type('deer near moab');
    const m = W.box.T_fq().parsed;
    ok('a word that is no unit\'s name ("moab") brings no unit offer', m.place.id === 'moab' && !m.alsoUnit && !/That is also the name of a hunt unit/.test(W.box.vFind()), JSON.stringify(m.alsoUnit));
  }

  /* 7. A sentence already read follows the towns. "near home" names a town, and home moves when the hunter takes the
        first town off or changes the words, so the held sentence is read again and the answer is for the town the
        header now shows. A sentence with no town in it, or one waiting on the phone's location, is left alone. */
  {
    const F = page(true, null, { app: true, ls: towns(['slc', 'heber']) });
    F.type('trout near home');
    const before = placeRows(F.box.T_vFish());
    ok('held sentence: "trout near home" on the Fish screen is measured from Salt Lake City to begin with', F.box.T_fish().parsed.place.id === 'slc' && F.box.T_vFish().indexOf('from Salt Lake City') >= 0 && before.length > 3 && before.every(r => r[1] === byId[r[0]].d.slc.min), JSON.stringify(before.slice(0, 3)));
    openTowns(F); tap(F, { town: 'slc' });
    const after = placeRows(F.box.T_vFish());
    ok('held sentence: with Salt Lake City taken off, the same "trout near home" is for Heber City, with Heber City\'s minutes and name',
      F.box.T_fish().parsed.place.id === 'heber' && F.box.T_vFish().indexOf('from Heber City') >= 0 && F.box.T_vFish().indexOf('from Salt Lake City') < 0 && after.length > 3 && after.every(r => r[1] === byId[r[0]].d.heber.min), JSON.stringify([F.box.T_fish().parsed.place, after.slice(0, 3)]));

    const H = page(true, null, { app: true, ls: towns(['slc', 'heber']) });
    H.box.T_hu(load('hunt_units_2026.json')); H.box.ODDS = load('draw_odds.json');
    H.type('pheasant near home');
    ok('held sentence: "pheasant near home" in the hunt finder is Salt Lake City to begin with', H.box.T_fq().parsed.place.id === 'slc' && H.box.vFind().indexOf('by drive from Salt Lake City') >= 0, JSON.stringify(H.box.T_fq().parsed.place));
    openTowns(H); tap(H, { town: 'slc' });
    ok('held sentence: ...and with Salt Lake City taken off it is Heber City, and the list says so', H.box.T_fq().parsed.place.id === 'heber' && H.box.vFind().indexOf('by drive from Heber City') >= 0 && H.box.vFind().indexOf('by drive from Salt Lake City') < 0, JSON.stringify(H.box.T_fq().parsed.place));

    const W = page(true, null, { app: true, ls: towns([{ id: 'slc', words: [] }, { id: 'heber', words: ['cabin'] }]) });
    W.type('trout near the cabin');
    ok('held sentence: "trout near the cabin" is Heber City while cabin is the word for it', W.box.T_fish().parsed.place && W.box.T_fish().parsed.place.id === 'heber', JSON.stringify(W.box.T_fish().parsed.place));
    openTowns(W); typed(W, 'heber', 'lodge');
    ok('held sentence: ...and once the word is changed the sentence is read again and no longer names a town', W.box.T_fish().parsed === null || W.box.T_fish().parsed.place === null, JSON.stringify(W.box.T_fish().parsed && W.box.T_fish().parsed.place));

    const G = page(true, null, { app: true, ls: towns(['slc', 'heber']) });
    G.type('trout where I am');
    const held = G.box.T_fish().parsed, asked = G.gps.length;
    openTowns(G); tap(G, { town: 'slc' }); typed(G, 'heber', 'camp');
    ok('held sentence: one that waits on the phone\'s location is not read again, and the phone is not asked a second time', asked === 1 && G.gps.length === 1 && G.box.T_fish().parsed === held, JSON.stringify([asked, G.gps.length]));
    G.box.tab = 'fish'; G.box.fishRun('trout');                 // what the Fish species chip runs
    const bare = G.box.T_fish().parsed;
    openTowns(G); typed(G, 'heber', 'den');
    ok('held sentence: one with no town in it is not read again, and still follows the header town as the list does', bare && bare.place === null && G.box.T_fish().parsed === bare, JSON.stringify(bare && bare.place));

    const T = page(true, null, { app: true, ls: towns(['slc', 'heber']) });
    T.box.T_hu(load('hunt_units_2026.json')); T.box.ODDS = load('draw_odds.json');
    T.type('elk');
    tap(T, { fask: 'place', fval: 'heber' });
    openTowns(T); tap(T, { town: 'slc' });
    ok('held sentence: a town the hunter tapped in the hunt finder is not thrown away when the towns change', T.box.T_fq().parsed.place && T.box.T_fq().parsed.place.id === 'heber', JSON.stringify(T.box.T_fq().parsed.place));
  }

  /* 8. Words typed for a town survive taking the town off and choosing it again on the same page, so a slip of the
        thumb does not lose them. They are not written anywhere else and are gone when the page is closed. */
  {
    const K = app(towns([{ id: 'slc' }, { id: 'heber', words: ['cabin', 'tree top'] }]));
    openTowns(K); tap(K, { town: 'heber' });
    ok('words kept: taking Heber City off drops it from the saved choice', same(kept(K), [{ id: 'slc', words: [] }]), K.store.get('ha.anchors'));
    tap(K, { town: 'heber' });
    ok('words kept: choosing it again brings its words back, last in order', same(kept(K), [{ id: 'slc', words: [] }, { id: 'heber', words: ['cabin', 'tree top'] }]) && /data-town-words="heber" value="cabin, tree top"/.test(view(K)), K.store.get('ha.anchors'));
    typed(K, 'heber', ''); tap(K, { town: 'heber' }); tap(K, { town: 'heber' });
    ok('words kept: words the hunter emptied before taking the town off do not come back', same(kept(K), [{ id: 'slc', words: [] }, { id: 'heber', words: [] }]), K.store.get('ha.anchors'));
    tap(K, { town: 'moab' });
    ok('words kept: a town never chosen before starts with none', same(kept(K).map(e => e.words), [[], [], []]), K.store.get('ha.anchors'));
    typed(K, 'moab', 'canyon'); tap(K, { town: 'moab' });
    const back = app(K.store);
    tap(back, { town: 'moab' });
    ok('words kept: a page opened afresh does not have them, and the saved choice never carried them', same(kept(back).filter(e => e.id === 'moab'), [{ id: 'moab', words: [] }]) && !/canyon/.test(K.store.get('ha.anchors')), K.store.get('ha.anchors'));
  }
}

/* ---- A fishing question asked before the rules arrive is answered when they do,
        with no second keystroke: while they load, and after a failed load and Try again. */
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
async function arriving() {
  const L = page(false, { on: true });
  const r = L.type('trout near home');                // the Fish screen starts the load
  ok('before the rules land, "trout near home" waits on the fishing finder', r.run === 'fish' && r.tab === 'fish' && r.rows === 0, show(r));
  await settle();
  const p = L.box.T_fish().parsed || {};
  ok('when the rules land, the trout near home results appear by themselves',
    L.box.T_state() === 'ready' && !p.pending && !!p.sp && p.place && p.place.kind === 'home' && rowsIn(L.box.T_vFish()) > 0,
    JSON.stringify({ state: L.box.T_state(), pending: !!p.pending, sp: !!p.sp }));

  const net = { on: false }, F = page(false, net);
  F.type('trout near home');
  await settle();
  ok('with no signal the load fails', F.box.T_state() === 'failed', F.box.T_state());
  net.on = true;
  F.box.fishLoad(true);                               // what Try again does
  await settle();
  const q = F.box.T_fish().parsed || {};
  ok('after Try again, the trout near home results appear by themselves',
    F.box.T_state() === 'ready' && !q.pending && !!q.sp && rowsIn(F.box.T_vFish()) > 0,
    JSON.stringify({ state: F.box.T_state(), pending: !!q.pending, sp: !!q.sp }));
}

/* ---- The rules land while another screen is showing: nothing happens there. The
        sentence waits, and runs when he comes back to Fish. */
async function elsewhere() {
  const C = page(false, { on: true });
  C.type('trout near me');
  C.box.tab = 'contacts'; C.renders.length = 0; C.gps.length = 0;   // he went to Contacts before they landed
  await settle();
  ok('rules land while on Contacts: no location is asked for', C.box.T_state() === 'ready' && C.gps.length === 0, 'gps=' + C.gps.join(','));
  ok('and Contacts is not redrawn', C.renders.length === 0, 'renders=' + C.renders.join(','));
  const kept = C.box.T_fish();
  ok('the sentence is kept for the Fish screen', kept.q === 'trout near me' && !!(kept.parsed && kept.parsed.pending), JSON.stringify({ q: kept.q }));
  C.box.tab = 'fish'; C.box.render();                 // he taps Fish
  const p = C.box.T_fish().parsed || {};
  ok('back on Fish, the sentence runs and asks for the location there', !p.pending && !!p.sp && p.place && p.place.kind === 'gps' && C.gps.join() === 'fish', JSON.stringify({ pending: !!p.pending, gps: C.gps }));

  const H = page(false, { on: true });
  H.type('trout near home');
  H.box.tab = 'remind';
  await settle();
  H.box.tab = 'fish'; H.box.render();
  const q = H.box.T_fish().parsed || {};
  ok('back on Fish, the trout near home results appear', !q.pending && !!q.sp && rowsIn(H.box.T_vFish()) > 0, JSON.stringify({ pending: !!q.pending }));
}

/* ---- A water named before the fishing rules are on the phone: its name is not known yet, so the
        sentence asks "Where?" and picks no unit (never a wrong answer); when the rules land the
        sentence is read again, and the water becomes the spot with the units under it. */
async function spotArrives() {
  for (const [s, unit, rows] of [['deer near fish lake', 'Fishlake', 8], ['elk near fish lake', 'Fishlake/Thousand Lakes', 7]]) {
    const L = page(false, { on: true });
    L.box.T_hu(load('hunt_units_2026.json')); L.box.ODDS = load('draw_odds.json');
    L.type(s);
    const html = L.box.vFind();                         // draws the screen, which starts the rules loading
    const early = L.box.T_fq().parsed || {};
    ok(`"${s}", rules not here yet: no place and no unit picked, so "Where?" and no hunt rows`, !early.place && !early.fish && /<div class="sec-title">Where\?</.test(html) && !/class="row"/.test(html), JSON.stringify({ place: early.place }));
    await settle();
    const q = L.box.T_fq().parsed || {}, h2 = L.box.vFind();
    ok(`"${s}", when the rules land the sentence is read again: Fish Lake, Sevier Co. with ${unit}, ${rows} rows`,
      q.place && q.place.kind === 'water' && q.place.label === 'Fish Lake, Sevier Co.' && L.box.unitsAt(q.place.lon, q.place.lat).some(u => u.n === unit) && (h2.match(/class="row"/g) || []).length === rows && !/<div class="sec-title">Where\?</.test(h2),
      JSON.stringify({ place: q.place && q.place.kind, rows: (h2.match(/class="row"/g) || []).length }));
  }
}

/* ---- The GPS fix belongs to the sentence, not to one reading of it. "deer where i am" typed before the
        fishing rules have landed is read again when they land; the fix (or refusal) that arrives before or
        after that re-read must still reach the answer, and the screen is never left on "Getting a GPS fix"
        with nothing pending. */
async function gpsLate() {
  const text = h => h.replace(/<[^>]*>/g, '|').replace(/&middot;/g, '.').replace(/&amp;/g, '&');
  const fixAt = { coords: { latitude: 38.5481, longitude: -111.70987 } };   // Fish Lake
  for (const [sentence, order, kind] of [['deer where i am', 'after', 'fix'], ['deer where i am', 'before', 'fix'], ['deer where i am', 'after', 'refused'], ['deer where i am', 'before', 'refused'], ['deer where i am', 'after', 'timeout'], ['chukar where I am', 'after', 'fix'], ['chukar where I am', 'before', 'fix']]) {
    const L = page(false, { on: true }), cbs = [];
    L.box.navigator.geolocation = { getCurrentPosition(okFn, errFn) { cbs.push({ okFn, errFn }); } };
    L.box.T_hu(load('hunt_units_2026.json')); L.box.ODDS = load('draw_odds.json');
    L.type(sentence);                                   // asks the phone; the rules have not landed
    L.box.vFind();                                      // draws the screen, which starts the rules loading
    const deliver = () => cbs.forEach(c => kind === 'fix' ? c.okFn(fixAt) : kind === 'refused' ? c.errFn({ code: 1, message: 'User denied Geolocation' }) : c.errFn({ code: 3, message: 'Timeout expired' }));
    if (order === 'before') deliver();
    await settle();                                     // the rules land and the sentence is read again
    if (order === 'after') deliver();
    const q = L.box.T_fq().parsed || {}, html = L.box.vFind(), tx = text(html);
    const rows = (html.match(/class="row"/g) || []).length, stuck = /Getting a GPS fix/.test(html);
    const label = `"${sentence}", ${kind} arriving ${order} the rules re-read the sentence`;
    ok(`${label}: one request to the phone, and never stuck on "Getting a GPS fix"`, cbs.length === 1 && !stuck, JSON.stringify({ requests: cbs.length, stuck }));
    if (kind === 'fix') ok(`${label}: answers from the fix`, sentence.startsWith('deer') ? (q.place && q.place.lat === 38.5481 && rows === 8 && html.indexOf('Hunt boundaries under that spot: <b>Fishlake') >= 0) : (q.place && q.place.lat === 38.5481 && rows > 0), JSON.stringify({ place: q.place, rows }));
    else ok(`${label}: says why, in words, above the Where? chips`, !q.place && (kind === 'refused' ? tx.indexOf('No GPS fix: User denied Geolocation. Allow location for this app in the phone settings and try again.') >= 0 : tx.indexOf('No GPS fix yet. Try again in the open.') >= 0 && tx.indexOf('Allow location') < 0), tx.slice(0, 200));
  }
  /* No location service at all: said at once, not left waiting. */
  const M = page(true);
  M.box.navigator.geolocation = undefined; M.box.T_hu(load('hunt_units_2026.json'));
  M.type('deer where i am');
  ok('"deer where i am" on a phone with no location service says so, not "Getting a GPS fix"', /This phone is not sharing location with the app\./.test(M.box.vFind()) && !/Getting a GPS fix/.test(M.box.vFind()), '');
}

arriving().then(elsewhere).then(spotArrives).then(gpsLate).then(() => {
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, e => { console.log('  FAIL threw: ' + e.stack); process.exit(1); });
