#!/usr/bin/env node
/* Checks where the Menu sends a typed sentence (docs/go.js): which screen opens,
   which finder runs, whether a search was run at all, and for the fishing finder
   whether it came back with waters or with its "does not know that water" box.
   It loads the real docs/finder.js, docs/fishing.js and docs/go.js with the data
   in docs/data and the browser stubbed. Run with:

       node scraper/test_go.js

   GO_JS=<file> runs the same checks against another copy of go.js, which is how
   the checks were shown to fail on the v27 Menu before it was fixed. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..'), D = p => path.join(ROOT, 'docs', p);
const load = f => JSON.parse(fs.readFileSync(D('data/' + f), 'utf8'));
const GO = process.env.GO_JS || D('go.js');

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

/* One page. withFishing false is the first run: the fishing rules have not arrived,
   so no water's name is known. net.on says whether a fetch of docs/data succeeds. */
const FILES = { 'fishing_rules.json': DATA.rules, 'fishing_places.json': DATA.places, 'fishing_notices.json': DATA.notices };
function page(withFishing, net) {
  net = net || { on: false };
  const runs = [], timers = [], landed = [], renders = [], gps = [];
  let nextTimer = 1;
  const box = {
    console, Date: TestDate, Math, JSON, Object, Array, String, Number, RegExp, Promise, Set, Map, Intl,
    document: { addEventListener() {} },
    window: { scrollTo() {}, addEventListener() {} },
    navigator: { geolocation: { getCurrentPosition() { gps.push(box.tab); } } }, localStorage: { getItem: () => null, setItem() {} },
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
    tab: 'today', home: 'heber', seasonsMode: 'dates', esc,
    miles(aLat, aLon, bLat, bLon) {
      const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
      return 3958.8 * 2 * Math.asin(Math.sqrt(h));
    },
    DB: { config: DATA.config, seasons: DATA.seasons, birds: DATA.birds },
    hlabel: () => 'Home', UNITS: DATA.units, ODDS: null, draw: { pts: {} }, loadOdds() {},
    fmt: d => String(d), d0: s => new Date(s), unitsAt: () => []
  };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(D('finder.js'), 'utf8') + '\n;this.T_fq = () => fq;', box);
  vm.runInContext(fs.readFileSync(D('fishing.js'), 'utf8') +
    '\n;this.T_fish = () => fish; this.T_vFish = vFish; this.T_state = () => fishState;' +
    ' this.T_set = function (r, p, n) { FR = r; FP = p || F_NOPLACES(); FNT = n; fNames = null; if (r) fishIndex(); fishState = "ready"; };', box);
  if (withFishing) box.T_set(DATA.rules, DATA.places, DATA.notices);
  vm.runInContext(fs.readFileSync(GO, 'utf8') + '\n;this.T_go = { goSubmit, goOpen, GO_DEST };', box);
  const realHunt = box.fRun, realFish = box.fishRun;
  box.fRun = q => { runs.push('hunt'); realHunt(q); };
  box.fishRun = q => { runs.push('fish'); realFish(q); };

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
  return { box, type, timers, landed, renders, gps };
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

arriving().then(elsewhere).then(() => {
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, e => { console.log('  FAIL threw: ' + e.stack); process.exit(1); });
