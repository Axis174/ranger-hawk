#!/usr/bin/env node
/* Checks the part of the fishing screen that works things out for itself: dates,
   which layer wins, and whether a sentence is about fishing at all. It loads the
   real docs/fishing.js and the real data files, with the browser stubbed out.

   Every expected value here was worked out by hand from the guidebook or a
   calendar, not by running the code and copying what it said.

       node scraper/fishing/test_fishing.js
*/
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
/* Run without arguments, the suite runs once for each of these clocks: the rules
   are Utah's, and a phone can be keeping any other state's time. */
const ZONES = ['America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/New_York', 'UTC', 'Pacific/Auckland'];
if (!process.env.FISH_TEST_ZONE) {
  const { spawnSync } = require('child_process');
  let bad = 0;
  for (const z of ZONES) {
    const r = spawnSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { TZ: z, FISH_TEST_ZONE: z }), encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || ''), last = out.trim().split('\n').pop();
    if (r.status !== 0) { bad++; console.log(out.trim()); }
    console.log((z + '                      ').slice(0, 22) + (r.status === 0 ? last : 'FAILED'));
  }
  console.log(bad ? `FAILED under ${bad} of ${ZONES.length} clocks` : `passed under all ${ZONES.length} clocks`);
  process.exit(bad ? 1 : 0);
}
const ROOT = path.resolve(__dirname, '..', '..'), D = p => path.join(ROOT, 'docs', p);
const load = f => JSON.parse(fs.readFileSync(D('data/' + f), 'utf8'));

/* The clock is stopped, so that the suite gives the same answer on any day it is
   run: noon in Utah on Sept. 27, 2026, the day the rules were built. A test that
   needs another moment sets CLOCK and puts FIXED back. */
const FIXED = Date.UTC(2026, 8, 27, 18, 0, 0);
let CLOCK = FIXED;
class TestDate extends Date {
  constructor(...a) { if (a.length) super(...a); else if (CLOCK != null) super(CLOCK); else super(); }
  static now() { return CLOCK != null ? CLOCK : Date.now(); }
}
const box = {
  console, Date: TestDate, Math, JSON, Object, Array, String, Number, RegExp, Promise, Set, Map, Intl,
  document: { addEventListener() {} }, window: { scrollTo() {}, addEventListener() {} },
  navigator: {}, localStorage: { getItem: () => null, setItem() {} },
  fetch: () => Promise.reject(new Error('no network in tests')),
  $: () => null, render() {}, openSheet() {}, loadWx() {}, tab: 'fish', home: 'heber',
  esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  miles(aLat, aLon, bLat, bLon) {
    const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
    return 3958.8 * 2 * Math.asin(Math.sqrt(h));
  },
  DB: { config: load('config.json'), seasons: load('seasons.json'), birds: [] },
  hlabel: () => 'Heber City',
  UNITS: load('units_geo.json').units, ODDS: null, draw: { pts: {} }, loadOdds() {}, seasonsMode: 'find',
  fmt: d => String(d), d0: s => new Date(s), unitsAt: () => []
};
vm.createContext(box);
vm.runInContext(fs.readFileSync(D('finder.js'), 'utf8') + '\n;this.fParse = fParse; this.vFind = vFind; this.fq = fq;', box);
vm.runInContext(fs.readFileSync(D('fishing.js'), 'utf8') +
  '\n;this.T = { set(r, p, n) { FR = r; FP = p || F_NOPLACES(); FNT = n; fNames = null; if (r) fishIndex(); }, fUtah, fNow, fDayAfter, fFlip, fStale, fOpens, fPlaceChips, fPlaceRes, fGroupsFor, fSpearFor, fKokaneeNow, fStatewideHtml, fishRun, fTokens, FTWIN: () => FTWIN, linked: () => FLINKED, fPoint, fSpan, fResolve, fSummary, fAmendState, fNotices, fishParse, fishWaterIn, fishMatches, fRuleNow, fHeld, fUnreadFor, fChips, fEdition, fStanding, fish, FW: () => FW, FAM: () => FAM, FPL: () => FPL, vFish, sheetFishWater, sheetFishPlace, cardFish, fishAnswer };', box);
const T = box.T;
const R = load('fishing_rules.json'), P = load('fishing_places.json'), N = load('fishing_notices.json');
T.set(R, P, N);

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; return; }
  fail++; console.log('  FAIL ' + name + '\n       got  ' + a + '\n       want ' + b);
};
const at = s => new Date(s);                       // local time, as the phone would have it
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const hm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

/* ---- Saturdays of 2026, read off a calendar. Two of them the guidebook states
        itself: Free Fishing Day is "Saturday, June 6, 2026" (p. 8) and the bass
        closure runs to "June 27, 2026 (the fourth Saturday in June)" (p. 20). */
const SAT = [[1, 6, '2026-06-06'], [4, 6, '2026-06-27'], [2, 7, '2026-07-11'], [3, 4, '2026-04-18'], [1, 5, '2026-05-02'],
  [3, 5, '2026-05-16'], [-1, 9, '2026-09-26'], [2, 9, '2026-09-12'], [2, 10, '2026-10-10'], [-1, 11, '2026-11-28'],
  [2, 12, '2026-12-12'], [-1, 2, '2026-02-28'], [-1, 5, '2026-05-30'], [1, 8, '2026-08-01']];
SAT.forEach(([n, m, want]) => ok(`Saturday n=${n} of month ${m}`, ymd(T.fPoint({ n, m }, 2026, false)), want));
ok('6 a.m. is kept', hm(T.fPoint({ n: 2, m: 7, h: 6 }, 2026, true)), '06:00');
ok('a day later', ymd(T.fPoint({ n: 3, m: 5, d: 1 }, 2026, false)), '2026-05-17');
ok('2027 second Saturday of July', ymd(T.fPoint({ n: 2, m: 7 }, 2027, false)), '2027-07-10');
ok('a span over the new year, in December', T.fSpan(['12-01', { n: -1, m: 2, h: 6 }], at('2026-12-05T12:00')).on, true);
ok('a span over the new year, in January', T.fSpan(['12-01', { n: -1, m: 2, h: 6 }], at('2026-01-15T12:00')).on, true);
ok('a span over the new year, in March', T.fSpan(['12-01', { n: -1, m: 2, h: 6 }], at('2026-03-15T12:00')).on, false);

/* ---- helpers */
const stand = (id, when, only) => { const r = T.fResolve(id, at(when), only || null); return { r, s: T.fSummary(r) }; };
const layer = (id, when, key) => T.fResolve(id, at(when), null).layers.find(l => (l.key || null) === (key || null));

/* ---- a stream that opens at 6 a.m. on the second Saturday of July */
ok('Strawberry tributaries (b), 5:59 a.m. July 11', layer('strawberry-reservoir-tributaries-wasatch', '2026-07-11T05:59', 'b').stand.closed, true);
ok('Strawberry tributaries (b), 6:01 a.m. July 11', layer('strawberry-reservoir-tributaries-wasatch', '2026-07-11T06:01', 'b').stand.closed, false);
ok('Strawberry tributaries (b), May 14', layer('strawberry-reservoir-tributaries-wasatch', '2026-05-14T12:00', 'b').stand.closed, false);
ok('Strawberry tributaries (b), May 15', layer('strawberry-reservoir-tributaries-wasatch', '2026-05-15T00:30', 'b').stand.closed, true);
ok('Strawberry tributaries (a) is closed all year', layer('strawberry-reservoir-tributaries-wasatch', '2026-09-27T12:00', 'a').stand.closed, true);
ok('Strawberry tributaries (b) is catch and release', layer('strawberry-reservoir-tributaries-wasatch', '2026-09-27T12:00', 'b').stand.cr, true);
ok('Strawberry tributaries (b) is flies and lures only', layer('strawberry-reservoir-tributaries-wasatch', '2026-09-27T12:00', 'b').stand.art, 'fl');
ok('Trout Creek (c) second closure, Sept 15', layer('strawberry-reservoir-tributaries-wasatch', '2026-09-15T12:00', 'c').stand.closed, true);
ok('Trout Creek (c) reopens 6 a.m. Oct 10', ymd(layer('strawberry-reservoir-tributaries-wasatch', '2026-09-15T12:00', 'c').stand.opens) + ' ' + hm(layer('strawberry-reservoir-tributaries-wasatch', '2026-09-15T12:00', 'c').stand.opens), '2026-10-10 06:00');

/* ---- a pointer follows the guidebook to the stretch that names it */
const bh = T.fResolve('badger-hollow-wasatch', at('2026-09-27T12:00'), null);
ok('Badger Hollow points to Strawberry tributaries', bh.target.id, 'strawberry-reservoir-tributaries-wasatch');
ok('Badger Hollow shows only stretch (b)', bh.layers.map(l => l.key), ['b']);
ok('Co-op Creek shows stretches (a) and (b)', T.fResolve('co-op-creek-wasatch', at('2026-09-27T12:00'), null).layers.map(l => l.key), ['a', 'b']);
ok('Squaw Creek shows only stretch (a), closed', T.fResolve('squaw-creek-wasatch', at('2026-09-27T12:00'), null).layers.map(l => [l.key, l.stand.closed]), [['a', true]]);

/* ---- Boulder Mountain lakes: closed Jan. 1 to the third Saturday of April, and Nov. 1 to Dec. 31 */
ok('Beaver Dam Reservoir, Sept 27', stand('beaver-dam-reservoir-wayne', '2026-09-27T12:00').s.closed, false);
ok('Beaver Dam Reservoir closes Nov 1', ymd(layer('beaver-dam-reservoir-wayne', '2026-09-27T12:00').stand.closes), '2026-11-01');
ok('Beaver Dam Reservoir, Nov 1', stand('beaver-dam-reservoir-wayne', '2026-11-01T00:10').s.closed, true);
ok('Beaver Dam Reservoir, April 18, 5 a.m.', stand('beaver-dam-reservoir-wayne', '2026-04-18T05:00').s.closed, true);
ok('Beaver Dam Reservoir, April 18, 7 a.m.', stand('beaver-dam-reservoir-wayne', '2026-04-18T07:00').s.closed, false);

/* ---- a limit that only applies part of the year */
ok('Annabella Lake 8-trout limit, Sept 27', stand('annabella-lake-sevier', '2026-09-27T12:00').r.rows, { trout: 'own' });
ok('Annabella Lake, July 1: statewide trout limit', stand('annabella-lake-sevier', '2026-07-01T12:00').r.rows, {});
ok('Annabella Lake, July 1: says a dated rule is waiting', stand('annabella-lake-sevier', '2026-07-01T12:00').r.later, true);

/* ---- a rule replaces only what it speaks to */
ok('Bear Lake takes the trout row only', stand('bear-lake-rich', '2026-09-27T12:00').r.rows, { trout: 'own' });
ok('Bear Lake leaves the rest statewide', stand('bear-lake-rich', '2026-09-27T12:00').r.all, false);
ok('Mona Reservoir takes every row', stand('mona-reservoir-juab', '2026-09-27T12:00').r.all, true);
ok('Cutler Reservoir', Object.keys(stand('cutler-reservoir-box-elder-cache', '2026-09-27T12:00').r.rows).sort(), ['catfish', 'crappie']);
ok('Weber River (b) touches trout and nongame', Object.keys(layer('weber-river-summit', '2026-09-27T12:00', 'b').stand.rows).sort(), ['nongame', 'trout']);

/* ---- open only between two dates */
ok('Deseret Reservoir, May 1 (the day before the first Saturday of May)', stand('deseret-reservoir-tooele', '2026-05-01T12:00').s.closed, true);
ok('Deseret Reservoir, May 2', stand('deseret-reservoir-tooele', '2026-05-02T12:00').s.closed, false);
ok('Deseret Reservoir, Oct 31', stand('deseret-reservoir-tooele', '2026-10-31T12:00').s.closed, false);
ok('Deseret Reservoir, Nov 1', stand('deseret-reservoir-tooele', '2026-11-01T12:00').s.closed, true);
ok('Deseret Reservoir is shore only', stand('deseret-reservoir-tooele', '2026-06-01T12:00').s.boat, ['shore']);

/* ---- Pond at Poulter Preserve: two rules that swap over the year */
let pp = layer('pond-at-poulter-preserve-weber', '2026-09-27T12:00');
ok('Poulter, Sept 27: catch and release', [pp.stand.cr, pp.stand.art], [true, 'fl']);
pp = layer('pond-at-poulter-preserve-weber', '2026-06-15T12:00');
ok('Poulter, June 15: the 2-fish limit, no catch and release', [pp.stand.cr, pp.stand.art, pp.stand.all], [false, null, true]);
pp = layer('pond-at-poulter-preserve-weber', '2026-05-16T20:00');
ok('Poulter, the third Saturday of May itself is still catch and release', pp.stand.cr, true);
pp = layer('pond-at-poulter-preserve-weber', '2026-05-17T00:30');
ok('Poulter, the day after: 2-fish limit', [pp.stand.cr, pp.stand.all], [false, true]);

/* ---- emergency changes: "until Oct. 1" is read as through Sept. 30 */
const am = id => T.FAM()[id][0];
ok('Palisade, Sept 30', T.fAmendState(am('palisade-reservoir-sanpete'), at('2026-09-30T23:00')).k, 'on');
ok('Palisade, Sept 30 is the last day', T.fAmendState(am('palisade-reservoir-sanpete'), at('2026-09-30T08:00')).left, 0);
ok('Palisade, Oct 1', T.fAmendState(am('palisade-reservoir-sanpete'), at('2026-10-01T00:05')).k, 'ended');
ok('Palisade, July 1 (the day before it began)', T.fAmendState(am('palisade-reservoir-sanpete'), at('2026-07-01T12:00')).k, 'later');
ok('Palisade, Sept 27: three days left', T.fAmendState(am('palisade-reservoir-sanpete'), at('2026-09-27T12:00')).left, 3);
ok('Crouse runs to Dec. 30', T.fAmendState(am('crouse-reservoir-uintah'), at('2026-12-30T12:00')).k, 'on');
ok('Crouse, Dec. 31', T.fAmendState(am('crouse-reservoir-uintah'), at('2026-12-31T12:00')).k, 'ended');
ok('in force on Sept 27, 2026', R.amendments.filter(a => T.fAmendState(a, at('2026-09-27T12:00')).k === 'on').length, 9);
ok('in force on Oct 1, 2026', R.amendments.filter(a => T.fAmendState(a, at('2026-10-01T12:00')).k === 'on').map(a => a.name).sort(), ['Crouse Reservoir', 'Pineview Reservoir', 'Red Creek Reservoir']);

/* ---- Minersville: the change replaces the two trout rules and nothing else */
let mv = stand('minersville-reservoir-beaver', '2026-09-27T12:00');
ok('Minersville, Sept 27: trout is set by the change', mv.r.rows, { trout: 'change' });
ok('Minersville, Sept 27: two rules struck out', Object.keys(mv.r.gone).length, 2);
ok('Minersville, Sept 27: flies and lures only stays', mv.s.art, 'fl');
ok('Minersville, Sept 27: the closed outlet channel stays', mv.s.part, true);
mv = stand('minersville-reservoir-beaver', '2026-10-01T12:00');
ok('Minersville, Oct 1: back to the guidebook', [mv.r.rows, Object.keys(mv.r.gone).length], [{ trout: 'own' }, 0]);

/* ---- Pineview: "no limit, all other species" takes the whole table */
let pv = stand('pineview-reservoir-weber', '2026-09-27T12:00');
ok('Pineview, Sept 27: every row is set by the change', pv.r.all, true);
ok('Pineview, Sept 27: crappie and tiger muskie rules struck out', Object.keys(pv.r.gone).length, 2);
ok('Pineview, Sept 27: a struck-out rule no longer claims its row', pv.r.rows, { bass: 'change', tigermuskie: 'change' });
ok('Pineview, Sept 27: the guidebook layer on its own claims nothing', [pv.r.layers[0].stand.rows, pv.r.layers[0].stand.keeps], [{}, false]);
ok('Pineview, Sept 27: the bait rule is still standing', pv.r.layers[0].rules.filter(r => !pv.r.gone[r.id]).map(r => r.text.slice(0, 32)), ['Unlawful to use whole fish for b']);
pv = stand('pineview-reservoir-weber', '2026-12-31T12:00');
ok('Pineview, Dec 31: crappie and tiger muskie are back', Object.keys(pv.r.rows).sort(), ['crappie', 'tigermuskie']);

/* ---- a community water under an emergency change */
let cv = stand('community:canyon-view-park-pond-utah', '2026-09-27T12:00');
ok('Canyon View, Sept 27: no limit, every row', cv.r.all, true);
ok('Canyon View, Sept 27: the 2-fish rule is struck out, the tiger muskie rule is not', cv.r.layers[0].rules.map(r => !!cv.r.gone[r.id]), [true, false, false, false]);
ok('Canyon View, Sept 27: the community layer no longer sets every limit, only tiger muskie', [cv.r.layers[0].stand.all, cv.r.layers[0].stand.rows], [false, { tigermuskie: 1 }]);
cv = stand('community:canyon-view-park-pond-utah', '2026-10-01T12:00');
ok('Canyon View, Oct 1: 2 fish again', [cv.r.all, Object.keys(cv.r.gone).length], [true, 0]);
ok('Spanish Oaks, Dec 5: closed', stand('community:spanish-oaks-reservoir-utah', '2026-12-05T12:00').s.closed, true);
ok('Spanish Oaks, Sept 27: open', stand('community:spanish-oaks-reservoir-utah', '2026-09-27T12:00').s.closed, false);
ok('Salem Pond is not touched by the Spanish Oaks note', stand('community:salem-pond-utah', '2026-12-05T12:00').s.closed, false);
ok('Burraston Ponds carries its own motor rule and the community rules', T.fResolve('community:burraston-ponds-juab', at('2026-09-27T12:00'), null).layers.map(l => l.kind), ['own', 'community']);

/* ---- a place outside every listed stretch */
const lowerProvo = T.FPL()['p10574'];
ok('Provo River, I-15 to Olmstead, is marked as outside the listed stretches', lowerProvo.r, 'none');
ok('...and takes no row from the river\'s rules', T.fResolve('provo-river-summit-utah-wasatch', at('2026-09-27T12:00'), 'none').rows, {});
ok('Middle Provo (d) is 2 trout under 15 inches, flies and lures', [Object.keys(layer('provo-river-summit-utah-wasatch', '2026-09-27T12:00', 'd').stand.rows), layer('provo-river-summit-utah-wasatch', '2026-09-27T12:00', 'd').stand.art], [['trout'], 'fl']);
ok('Provo (c) says statewide and takes nothing', layer('provo-river-summit-utah-wasatch', '2026-09-27T12:00', 'c').stand.rows, {});

/* ---- the year the rules are for */
ok('2026 is current', T.fEdition(at('2026-09-27T12:00')).current, true);
box.T.fish.now = '2027-01-01T08:00';
ok('after the year ends every chip says the rules are out of date', T.fChips({ closed: true, boat: [] }, true, null), [['crit', 'Rules out of date']]);
ok('...and every sheet says so', /2026 is over/.test(T.sheetFishWater('bear-lake-rich')), true);
box.fq.text = 'trout near the cabin'; box.fq.parsed = box.fParse('trout near the cabin');
ok('...and so does an answer from the hunt finder', /2026 is over/.test(box.vFind()), true);
ok('...and no opening date is worked out from last year\'s rules', /Opens |Last day open/.test(T.sheetFishWater('beaver-dam-reservoir-wayne')), false);
box.T.fish.now = null;
ok('Jan. 1, 2027 is late', T.fEdition(at('2027-01-01T00:05')).late, true);

/* ---- what UDWR lists against what has been read in */
ok('nothing unread today', T.fNotices().unread.length, 0);
const N2 = JSON.parse(JSON.stringify(N));
N2.notices.push({ slug: 'emergency-change-2026-10-02-test-lake', title: 'Test Lake (Wayne County)', name: 'Test Lake', county: 'Wayne', text: [['p', 'x']], sha: 'x', url: 'https://wildlife.utah.gov/x.pdf' });
N2.notices = N2.notices.filter(n => !/pineview/.test(n.slug));
N2.guidebook.sha = 'ffffffffffffffff';
T.set(R, P, N2);
ok('a notice nobody has read in is flagged', T.fNotices().unread.map(n => n.name), ['Test Lake']);
ok('a notice UDWR has taken down is flagged', T.fNotices().gone.map(a => a.name), ['Pineview Reservoir']);
ok('a replaced guidebook file is flagged', T.fNotices().book, true);
/* A change UDWR has taken down: one that raised a limit is set aside, and the
   guidebook rule, which is the stricter one, is what the water shows. */
ok('Pineview is set aside once UDWR stops listing it', T.fAmendState(am('pineview-reservoir-weber'), at('2026-09-27T12:00')).k, 'held');
pv = stand('pineview-reservoir-weber', '2026-09-27T12:00');
ok('...and its guidebook rules are back in force', [Object.keys(pv.r.rows).sort(), Object.keys(pv.r.gone).length, pv.r.all], [['crappie', 'tigermuskie'], 0, false]);
ok('...and the list row says so', T.fChips(pv.s, false, pv.r).map(c => c[1]).indexOf('Change set aside') >= 0, true);
ok('a change still listed is not touched', T.fAmendState(am('crouse-reservoir-uintah'), at('2026-09-27T12:00')).k, 'on');
const N3 = JSON.parse(JSON.stringify(N));
N3.notices.find(n => /minersville/.test(n.slug)).sha = 'reworded00000000';
N3.notices.push({ slug: 'emergency-change-2026-10-02-strawberry-reservoir', title: 'Strawberry Reservoir (Wasatch County)', name: 'Strawberry Reservoir', county: 'Wasatch', text: [['p', 'x']], sha: 'y', url: 'https://wildlife.utah.gov/y.pdf' });
T.set(R, P, N3);
ok('a reworded notice that raised a limit is set aside', T.fAmendState(am('minersville-reservoir-beaver'), at('2026-09-27T12:00')).k, 'held');
ok('an unread notice is pinned to the water it names', T.fResolve('strawberry-reservoir-wasatch', at('2026-09-27T12:00'), null).unread.length, 1);
ok('...and not to its neighbours', [T.fResolve('strawberry-river-duchesne-wasatch', at('2026-09-27T12:00'), null).unread.length, T.fResolve('strawberry-reservoir-tributaries-wasatch', at('2026-09-27T12:00'), null).unread.length], [0, 0]);
const RL = JSON.parse(JSON.stringify(R));
RL.amendments.find(a => /palisade/.test(a.notice)).direction = 'less';
T.set(RL, P, Object.assign({}, N, { notices: N.notices.filter(n => !/palisade/.test(n.slug)) }));
ok('a change that tightened a rule is kept when UDWR stops listing it', [T.fAmendState(T.FAM()['palisade-reservoir-sanpete'][0], at('2026-09-27T12:00')).k, T.fAmendState(T.FAM()['palisade-reservoir-sanpete'][0], at('2026-09-27T12:00')).why], ['on', 'gone']);
T.set(R, P, Object.assign({}, N, { ok: false }));
ok('a failed read of the list sets nothing aside', Object.keys(T.fHeld()).length, 0);
T.set(R, P, null);
ok('no list on the phone at all is flagged', T.fNotices().failed, true);
ok('...and sets nothing aside', [Object.keys(T.fHeld()).length, T.fAmendState(am('palisade-reservoir-sanpete'), at('2026-09-27T12:00')).k], [0, 'on']);
T.set(R, P, N);

/* ---- is the sentence about fishing? */
const fp = s => { const q = T.fishParse(s); return q ? [q.sp ? q.sp[0] : null, q.place ? (q.place.id || q.place.kind) : null, q.water ? q.water.needle : null, q.county] : null; };
ok('"where can I fish for trout near the cabin"', fp('where can I fish for trout near the cabin'), ['trout', 'heber', null, null]);
ok('"tiger trout near torrey"', fp('tiger trout near torrey'), ['tigertrout', 'torrey', null, null]);
ok('"striped bass"', fp('striped bass'), ['striper', null, null, null]);
ok('"white bass near home"', fp('white bass near home'), ['whitebass', 'nsl', null, null]);
ok('"smallmouth where I am"', fp('smallmouth where I am'), ['smallmouth', 'gps', null, null]);
ok('"fishing in wasatch county"', fp('fishing in wasatch county'), [null, null, null, 'Wasatch']);
ok('"walleye in utah county"', fp('walleye in utah county'), ['walleye', null, null, 'Utah']);
ok('"strawberry reservoir rules"', fp('strawberry reservoir rules'), [null, null, 'strawberry reservoir', null]);
ok('"trout at fish lake"', fp('trout at fish lake'), ['trout', null, 'fish lake', null]);
ok('"fishing sheep creek lake" is not bighorn sheep', fp('fishing sheep creek lake'), [null, null, 'sheep creek lake', null]);
ok('"bass at quail creek reservoir" is not quail', fp('bass at quail creek reservoir'), ['bass', null, 'quail creek reservoir', null]);
ok('"provo river delta" before "provo river"', fp('fishing the provo river delta'), [null, null, 'provo river delta', null]);
ok('"elk by my cabin" is left to the hunt finder', fp('elk by my cabin'), null);
ok('"pheasant near north salt lake" is left to the hunt finder', fp('pheasant near north salt lake'), null);
ok('"duck hunting near fish lake" is left to the hunt finder', fp('duck hunting near fish lake'), null);
ok('"chukar where I am" is left to the hunt finder', fp('chukar where I am'), null);
ok('"limited entry elk Wasatch, 7 points" is left to the hunt finder', fp('limited entry elk Wasatch, 7 points'), null);
ok('"deer near antelope island" is left to the hunt finder', fp('deer near antelope island'), null);
ok('"sage grouse" is left to the hunt finder', fp('sage grouse'), null);
ok('"is pineview open" finds the reservoir by its short name', fp('is pineview open'), [null, null, 'pineview', null]);
ok('"trout at strawberry" finds every Strawberry entry', [fp('trout at strawberry')[2], T.fishParse('trout at strawberry').water.refs.filter(r => r.w).map(r => r.w).sort()], ['strawberry', ['strawberry-reservoir-tributaries-wasatch', 'strawberry-reservoir-wasatch', 'strawberry-river-duchesne-wasatch']]);
ok('"elk near strawberry" is left to the hunt finder', fp('elk near strawberry'), null);
ok('a short name that is also an animal is never matched: "fishing at bear"', fp('fishing at bear'), [null, null, null, null]);
ok('a short name that is also a home word is never matched: "trout near boulder"', fp('trout near boulder'), ['trout', 'torrey', null, null]);
ok('typed on the Fish tab, a bare name is about fishing', T.fishParse('jordanelle', true).water.needle, 'jordanelle');

/* ---- the hunt finder and the fishing finder share one box */
const hp = s => { const q = box.fParse(s); return q.fish ? 'fish:' + (q.fish.water ? q.fish.water.needle : (q.fish.sp ? q.fish.sp[0] : '')) : 'hunt:' + (q.sp || (q.bird && q.bird[0]) || '') + (q.alsoWater ? '+' + q.alsoWater : ''); };
ok('hunt finder: "elk by the cabin"', hp('elk by the cabin'), 'hunt:elk');
ok('hunt finder: "pheasant near north salt lake"', hp('pheasant near north salt lake'), 'hunt:pheasant');
ok('hunt finder: "deer near antelope island"', hp('deer near antelope island'), 'hunt:deer');
ok('hunt finder: "mountain goat near the cabin"', hp('mountain goat near the cabin'), 'hunt:mountain goat');
ok('hunt finder: "bull moose by the cabin"', hp('bull moose by the cabin'), 'hunt:moose');
ok('hunt finder: "duck fork reservoir" is a water, not a duck', hp('duck fork reservoir'), 'fish:duck fork reservoir');
ok('hunt finder: "moose pond" is a water, not a moose', hp('moose pond'), 'fish:moose pond');
ok('hunt finder: "sheep creek lake" is a water, not a sheep', hp('sheep creek lake'), 'fish:sheep creek lake');
ok('hunt finder: "quail creek reservoir" is a water, not a quail', hp('quail creek reservoir'), 'fish:quail creek reservoir');
ok('hunt finder: "deer creek reservoir"', hp('deer creek reservoir'), 'fish:deer creek reservoir');
ok('hunt finder: "ducks near deer creek reservoir" is a hunt that also names a water', hp('ducks near deer creek reservoir'), 'hunt:duck+deer creek reservoir');
ok('hunt finder: "elk near strawberry reservoir"', hp('elk near strawberry reservoir'), 'hunt:elk+strawberry reservoir');
ok('hunt finder: "duck hunting near fish lake"', hp('duck hunting near fish lake'), 'hunt:duck+fish lake');
ok('hunt finder: "trout near the cabin"', hp('trout near the cabin'), 'fish:trout');
ok('hunt finder: a unit that shares its name with a water stays a hunt ("panguitch lake")', hp('panguitch lake'), 'hunt:+panguitch lake');
ok('hunt finder: "archery panguitch lake"', hp('archery panguitch lake'), 'hunt:+panguitch lake');

const near = T.fishMatches(T.fishParse('trout near the cabin'));
ok('trout near the cabin: the nearest is on the middle Provo', /^Provo River, Middle/.test(near[0].n), true);
ok('trout near the cabin: every place lists a trout', near.every(p => (p.sp || []).some(s => /trout|splake|kokanee|grayling/i.test(s[0]))), true);

/* ---- nothing unsorted reached the phone, and every screen draws */
let uns = 0;
R.waters.forEach(w => (w.reaches || []).forEach(r => r.rules.forEach(ru => ru.fx.forEach(fx => { if (fx.t === 'unsorted') uns++; }))));
ok('no unsorted rule in the data', uns, 0);
let drew = 0, broke = [];
box.T.fish.now = '2026-09-27T12:00';
R.waters.forEach(w => { try { if (T.sheetFishWater(w.id).length > 50) drew++; } catch (e) { broke.push(w.id + ': ' + e.message); } });
R.community.members.forEach(m => { try { if (T.sheetFishWater('community:' + m.id).length > 50) drew++; } catch (e) { broke.push(m.id + ': ' + e.message); } });
P.places.forEach(p => { try { if (T.sheetFishPlace(p).length > 50) drew++; } catch (e) { broke.push(p.id + ': ' + e.message); } });
ok('every water, community pond and place opens', [drew, broke.slice(0, 5)], [R.waters.length + R.community.members.length + P.places.length, []]);
['near', 'rules', 'state', 'now'].forEach(m => { box.T.fish.mode = m; let n = 0; try { n = T.vFish().length; } catch (e) { broke.push(m + ': ' + e.message); } ok('the ' + m + ' screen draws', n > 500, true); });
ok('the Today card draws', T.cardFish().length > 100, true);

/* ================= added after the code review of 2026-09-27 ================= */
box.T.fish.now = null;
T.set(R, P, N);
const J = o => JSON.parse(JSON.stringify(o));
const sheet = (id, when) => { box.T.fish.now = when; const h = T.sheetFishWater(id); box.T.fish.now = null; return h; };
const psheet = (pid, when) => { box.T.fish.now = when; const h = T.sheetFishPlace(T.FPL()[pid]); box.T.fish.now = null; return h; };
const chipsOf = (pid, when) => T.fPlaceChips(T.FPL()[pid], at(when)).map(c => c[1]);

/* ---- the end of a span is the first moment outside it */
ok('"through April 30" holds to the last half second of April 30', T.fSpan(['01-01', '04-30'], new Date(2026, 3, 30, 23, 59, 59, 500)).on, true);
ok('...and ends when May 1 begins', T.fSpan(['01-01', '04-30'], new Date(2026, 4, 1, 0, 0, 0)).on, false);
ok('"through 6 a.m." holds at 5:59:59', T.fSpan(['01-01', { n: 2, m: 7, h: 6 }], new Date(2026, 6, 11, 5, 59, 59)).on, true);
ok('...and ends at 6 a.m. sharp', T.fSpan(['01-01', { n: 2, m: 7, h: 6 }], new Date(2026, 6, 11, 6, 0, 0)).on, false);
ok('a span that starts the day it ends (Dec. 31 to Dec. 31) is one day long', [T.fSpan(['12-31', '12-31'], at('2026-12-31T12:00')).on, T.fSpan(['12-31', '12-31'], at('2026-12-30T12:00')).on], [true, false]);

/* ---- "opens" is the day the water is really open, across every rule that shuts it */
let bd = layer('beaver-dam-reservoir-wayne', '2026-11-15T12:00').stand;
ok('Beaver Dam Reservoir, Nov 15: shut, and the Nov-Dec closure runs into the Jan-April one', [bd.closed, ymd(bd.opens), hm(bd.opens)], [true, '2027-04-17', '06:00']);
ok('...so the sheet does not promise a 2026 opening', [/Closed for the rest of 2026/.test(sheet('beaver-dam-reservoir-wayne', '2026-11-15T12:00')), /Opens /.test(sheet('beaver-dam-reservoir-wayne', '2026-11-15T12:00'))], [true, false]);
bd = layer('beaver-dam-reservoir-wayne', '2026-02-01T12:00').stand;
ok('Beaver Dam Reservoir, Feb 1: opens 6 a.m. on April 18', [bd.closed, ymd(bd.opens), hm(bd.opens)], [true, '2026-04-18', '06:00']);
let ds = layer('deseret-reservoir-tooele', '2026-02-01T12:00').stand;
ok('Deseret Reservoir, Feb 1: opens May 2, the first Saturday of May, not April 30 or May 1', [ds.closed, ymd(ds.opens)], [true, '2026-05-02']);
ds = layer('deseret-reservoir-tooele', '2026-06-15T23:00').stand;
ok('Deseret Reservoir, June 15: open, shuts when Nov 1 begins', [ds.closed, ymd(ds.closes), hm(ds.closes)], [false, '2026-11-01', '00:00']);
ok('...which the sheet prints as the last day open', /Last day open Oct 31, 2026/.test(sheet('deseret-reservoir-tooele', '2026-06-15T12:00')), true);
ok('Deseret Reservoir: the row in the list says daylight hours only', T.fChips(stand('deseret-reservoir-tooele', '2026-06-15T23:00').s, false, stand('deseret-reservoir-tooele', '2026-06-15T23:00').r).map(c => c[1]), ['Daylight hours only', 'Shore only']);
ok('Deseret Reservoir is daylight hours only, and says so at 11 p.m.', [ds.day, /Open today, daylight hours only/.test(sheet('deseret-reservoir-tooele', '2026-06-15T23:00')), /Open now/.test(sheet('deseret-reservoir-tooele', '2026-06-15T23:00'))], [true, true, false]);
ok('Spanish Oaks, Dec 5: shut into next year', [stand('community:spanish-oaks-reservoir-utah', '2026-12-05T12:00').s.closed, /Closed for the rest of 2026/.test(sheet('community:spanish-oaks-reservoir-utah', '2026-12-05T12:00'))], [true, true]);
ok('Spanish Oaks, Jan 15: opens 6 a.m. on Feb 28, the last Saturday of February', (() => { const l = T.fResolve('community:spanish-oaks-reservoir-utah', at('2026-01-15T12:00'), null).layers.find(x => x.kind === 'community').stand; return [l.closed, ymd(l.opens), hm(l.opens)]; })(), [true, '2026-02-28', '06:00']);

/* ---- Utah's clock, whatever the phone is set to. Utah is UTC-6 in summer and UTC-7 in winter. */
ok('06:30 UTC on Oct 1 is 12:30 a.m. on Oct 1 in Utah', [ymd(T.fUtah(new Date('2026-10-01T06:30:00Z'))), hm(T.fUtah(new Date('2026-10-01T06:30:00Z')))], ['2026-10-01', '00:30']);
ok('05:30 UTC on Oct 1 is still Sept 30 in Utah', [ymd(T.fUtah(new Date('2026-10-01T05:30:00Z'))), hm(T.fUtah(new Date('2026-10-01T05:30:00Z')))], ['2026-09-30', '23:30']);
ok('06:30 UTC on Dec 15 is 11:30 p.m. on Dec 14 in Utah', [ymd(T.fUtah(new Date('2026-12-15T06:30:00Z'))), hm(T.fUtah(new Date('2026-12-15T06:30:00Z')))], ['2026-12-14', '23:30']);
ok('noon UTC on July 11 is 6 a.m. in Utah, the hour the streams open', hm(T.fUtah(new Date('2026-07-11T12:00:00Z'))), '06:00');
/* The phone's own clock is stopped at 06:30 UTC on Oct 1, 2026: half past midnight in
   Utah, and still Sept 30 in Arizona, Nevada and California. */
CLOCK = Date.UTC(2026, 9, 1, 6, 30, 0);
ok('"now" is Utah\'s now, whatever the phone is set to', [ymd(T.fNow()), hm(T.fNow())], ['2026-10-01', '00:30']);
ok('...so Palisade\'s change, which ran through Sept 30, has ended', T.fAmendState(T.FAM()['palisade-reservoir-sanpete'][0], T.fNow()).k, 'ended');
CLOCK = Date.UTC(2026, 3, 15, 6, 30, 0);          // 12:30 a.m. on April 15 in Utah
ok('...and Bear Lake\'s tributaries, shut from April 15, are shut', [ymd(T.fNow()), T.fResolve('bear-lake-tributaries-rich', T.fNow(), null).layers.some(l => l.stand.closed)], ['2026-04-15', true]);
CLOCK = Date.UTC(2026, 8, 26, 10, 30, 0);         // 4:30 a.m. on Sept 26 in Utah, 6:30 a.m. in New York
ok('...and a 6 a.m. opening has not come at 4:30 a.m. Utah time', [hm(T.fNow()), T.fSpan(['01-01', { n: -1, m: 9, h: 6 }], T.fNow()).on], ['04:30', true]);
CLOCK = FIXED;
ok('the day after Oct 31 is Nov 1, and after Nov 1, when the clocks go back, Nov 2', [ymd(T.fDayAfter('2026-10-31')), ymd(T.fDayAfter('2026-11-01')), ymd(T.fDayAfter('2026-03-08'))], ['2026-11-01', '2026-11-02', '2026-03-09']);
ok('Minersville: "Replaced until Oct 1, 2026"', /Replaced until Oct 1, 2026/.test(sheet('minersville-reservoir-beaver', '2026-09-27T12:00')), true);

/* ---- one pond under two names */
let bu = T.fResolve('burraston-ponds-juab', at('2026-09-27T12:00'), null);
ok('Burraston Ponds, opened by its own entry, still carries the community rules', [bu.layers.map(l => l.kind), bu.all], [['own', 'community'], true]);
ok('...and the 2-fish limit is on its sheet', /The daily limit is 2 fish/.test(sheet('burraston-ponds-juab', '2026-09-27T12:00')), true);
ok('...and the place is one water, not two', T.fPlaceRes(T.FPL()['p295'], at('2026-09-27T12:00')).length, 1);
ok('...and the finder counts one entry', />burraston ponds &middot; 1 guidebook entry</.test(T.fishAnswer(T.fishParse('burraston ponds', true))), true);
ok('no other pond is both', Object.keys(T.FTWIN()).sort(), ['burraston-ponds-juab', 'community:burraston-ponds-juab']);

/* ---- the statewide kokanee closure, Sept. 10 through Nov. 30 (guidebook p. 7) */
ok('Strawberry Reservoir, Sept 27: the sheet says kokanee may not be kept', /kokanee salmon may not be kept/.test(sheet('strawberry-reservoir-wasatch', '2026-09-27T12:00')), true);
ok('Porcupine Reservoir, Nov 30: still says so', /kokanee salmon may not be kept/.test(sheet('porcupine-reservoir-cache', '2026-11-30T20:00')), true);
ok('Porcupine Reservoir, Dec 1: no longer', /kokanee salmon may not be kept/.test(sheet('porcupine-reservoir-cache', '2026-12-01T00:30')), false);
ok('Strawberry Reservoir, Sept 9: not yet', /kokanee salmon may not be kept/.test(sheet('strawberry-reservoir-wasatch', '2026-09-09T12:00')), false);
ok('a place with no entry of its own carries it too', /kokanee salmon may not be kept/.test(psheet('p10060', '2026-09-27T12:00')), true);

/* ---- the statewide figure is never hidden */
let ml = sheet('moon-lake-duchesne', '2026-09-27T12:00');
ok('Moon Lake: "Limit 2 splake (goes toward the statewide trout limit)" leaves the statewide 4 in view', [/Trout, kokanee salmon and Arctic grayling<span class="fdates">see the rule above, which names splake<\/span><\/td><td>statewide: 4</.test(ml), /Largemouth and smallmouth bass<\/td><td>6</.test(ml)], [true, true]);
ok('Mona Reservoir, where every row is changed, still prints every statewide figure', (sheet('mona-reservoir-juab', '2026-09-27T12:00').match(/<td>statewide: /g) || []).length, 20);
ok('a water with no limit rule prints the table unmarked', [(sheet('deseret-reservoir-tooele', '2026-06-15T12:00').match(/<td>statewide: /g) || []).length, /<td>4<\/td>/.test(sheet('deseret-reservoir-tooele', '2026-06-15T12:00'))], [0, true]);
ok('Gunlock Reservoir: two rules name bass, and the statewide 6 stays in view', (() => { const m = /Largemouth and smallmouth bass<span class="fdates">see the rule above, which names ([a-z, ]+)<\/span><\/td><td>statewide: 6</.exec(sheet('gunlock-reservoir-washington', '2026-09-27T12:00')); return m ? m[1].split(', ').sort() : null; })(), ['largemouth bass', 'smallmouth bass']);
ok('East Fork Boulder Creek: "No limit for brook trout" names brook trout, and the statewide 4 stays in view', /which names brook trout<\/span><\/td><td>statewide: 4</.test(sheet('east-fork-boulder-creek-garfield', '2026-09-27T12:00')), true);

/* ---- a rule for a group of waters */
const grp = (name, c, k) => T.fGroupsFor(name, c, k, []).map(g => g.id);
ok('a lake on Boulder Mountain is offered the Boulder Mountain rule', grp('Beaver Dam Reservoir', ['Wayne'], 'lake'), ['boulder-mountain-lakes-and-reservoirs-garfield-wayne']);
ok('a stream in Wayne County is not', grp('Pleasant Creek', ['Wayne'], 'stream'), ['colorado-river-tributaries-garfield-grand-wayne']);
ok('a stream in Utah County is offered the Utah Lake and Scofield tributaries', grp('Hobble Creek', ['Utah'], 'stream'), ['scofield-reservoir-tributaries-carbon-sanpete-utah', 'utah-lake-tributaries-utah']);
ok('a reservoir in Utah County is offered neither', grp('Tibble Fork Reservoir', ['Utah'], 'lake'), []);
ok('an access property, which could be either, is offered every group in its county', grp('Some Angler Access', ['Summit'], null), ['uinta-mountains-lakes-and-streams-summit', 'whitney-reservoir-tributaries-summit']);
ok('Beaver Dam Reservoir\'s sheet shows the motor rule of the group', /Group rules that may also cover this water[\s\S]*Fishing from a boat with a motor is unlawful, except at Wide Hollow Reservoir, Pine Lake and Lower Bowns Reservoir/.test(sheet('beaver-dam-reservoir-wayne', '2026-09-27T12:00')), true);
ok('Lower Bowns Reservoir is told it is named as an exception', /The guidebook names Lower Bowns Reservoir as an exception/.test(psheet('p10036', '2026-09-27T12:00')), true);
ok('...and its row in the list says to check the group rule', chipsOf('p10036', '2026-09-27T12:00'), ['Check group rule']);
ok('a community pond is not offered group rules', /Group rules that may also cover/.test(sheet('community:salem-pond-utah', '2026-09-27T12:00')), false);

/* ---- underwater spearfishing, guidebook pp. 19-21 */
let pvs = sheet('pineview-reservoir-weber', '2026-09-27T12:00');
ok('Pineview: the spearfishing closure for tiger muskie is on the sheet', /Underwater spearfishing &middot; guidebook pp\. 19-21[\s\S]*Named as[\s\S]*Pineview Reservoir, Weber County[\s\S]*<span class="ftopic">Spearfishing<\/span><span class="ftext">CLOSED year-round to the take of tiger muskie/.test(pvs), true);
ok('Flaming Gorge is named twice in the spearfishing section (p. 20), under a shorter name', T.fSpearFor('flaming-gorge-reservoir-daggett', 'Flaming Gorge Reservoir', ['Daggett']).map(x => [x.sec.id, x.e.name]), [['bass', 'Flaming Gorge'], ['except', 'Flaming Gorge']]);
ok('Pineview: the emergency change says what it leaves standing', /Still stands<\/span><span class="ftext"><i>Underwater spearfishing at Pineview Reservoir:<\/i> CLOSED year-round to the take of tiger muskie/.test(pvs), true);
/* p. 19: "Only the waters listed below are open to underwater spearfishing for game fish year-round." */
let mls = sheet('moon-lake-duchesne', '2026-09-27T12:00');
ok('a water the spearfishing lists do not name says so, in the guidebook\'s words', [/The app did not find this water in the guidebook's lists of waters open to spearfishing/.test(mls), /Only the waters listed below are open to underwater spearfishing for game fish year-round\./.test(mls), /Named as/.test(mls)], [true, true, false]);
ok('Minersville, Sept 27: opened to spearfishing by the emergency change, and says it is the change that opens it', [/An emergency change above opens this water to spearfishing while it is in force/.test(sheet('minersville-reservoir-beaver', '2026-09-27T12:00')), /The app did not find this water/.test(sheet('minersville-reservoir-beaver', '2026-09-27T12:00'))], [true, false]);
ok('Minersville, Oct 1: the change has ended, so it is no longer said to be open', [/An emergency change above opens this water/.test(sheet('minersville-reservoir-beaver', '2026-10-01T12:00')), /The app did not find this water/.test(sheet('minersville-reservoir-beaver', '2026-10-01T12:00'))], [false, true]);
let prs = sheet('provo-river-summit-utah-wasatch', '2026-09-27T12:00');
ok('Provo River: carp and chub may not be speared there (p. 19), and nothing else may (p. 21)', [/you can underwater spearfish for common carp and Utah chub, except for the Provo River and Provo River Delta\./.test(prs), /Spearfishing is not permitted in the Provo River or Provo River Delta\./.test(prs)], [true, true]);
ok('Provo River Delta: the same two sentences', [/except for the Provo River and Provo River Delta\./.test(sheet('provo-river-delta-utah', '2026-09-27T12:00')), /Spearfishing is not permitted in the Provo River or Provo River Delta\./.test(sheet('provo-river-delta-utah', '2026-09-27T12:00'))], [true, true]);
ok('the general rules for spearfishing are held, seven of them, with the two exceptions to the light rule', [R.spear.general.length, R.spear.general.find(r => r.id === 'sg-light').items.length, R.spear.general.map(r => r.page)], [7, 2, [19, 19, 19, 19, 19, 19, 21]]);
ok('...and printed on every sheet and under Statewide', [/Free shafting is prohibited\./.test(mls), /Free shafting is prohibited\./.test(pvs), (() => { box.T.fish.mode = 'state'; box.T.fish.now = '2026-09-27T12:00'; const h = T.vFish(); box.T.fish.now = null; box.T.fish.mode = 'near'; return /Free shafting is prohibited\./.test(h) && /It is illegal to use artificial light while underwater spearfishing/.test(h); })()], [true, true, true]);

/* ---- general rules, quoted by hand and read against pages 8 to 24 by an independent checker */
const gr = id => R.statewide.rules.find(r => r.id === id);
ok('39 general rules are held', R.statewide.rules.length, 39);
ok('artificial light is allowed when angling, with the pointer to the spearfishing rule (pp. 11-12)', gr('light').text, 'The use of artificial light is allowed when angling statewide. (Important: See page 19 for Underwater spearfishing rules regarding artificial light.)');
ok('two poles: the paragraph goes on to say when more lines may be used (p. 11)', [/You may use additional lines or hooks when you are:$/.test(gr('two-poles').text), gr('two-poles').items.length, /^Ice fishing at Flaming Gorge, Porcupine and Causey reservoirs and Pelican Lake\./.test(gr('two-poles').items[2])], [true, 3, true]);
ok('hooks on a line: the sentence is whole (p. 11)', /This does not apply to setlines; please see page 13 of this guide for more information about fishing with a setline\.$/.test(gr('hooks').text), true);
ok('filleting: the paragraph goes on to say when fish may be filleted (p. 23)', [/At most waters, you may fillet harvested game fish, or remove their heads or tails, after you have:$/.test(gr('fillet').text), gr('fillet').items], [true, ['Completed the act of fishing', 'Arrived at camp', 'Reached a fish-cleaning station', 'Arrived at a principle means of land transportation']]);
ok('the heading for the four waters says trout and salmon, not every fish', gr('fillet-four').head, 'Four waters where trout and salmon stay whole');
ok('Free Fishing Day is Saturday, June 6, 2026 (p. 8)', /is Saturday, June 6, 2026, which is Free Fishing Day\./.test(gr('free-day').text), true);
ok('Lake Powell\'s sheet carries the rule on Utah and Arizona licences', /General rules that name this water[\s\S]*If you have a valid Utah or Arizona fishing or combination license/.test(sheet('lake-powell-garfield-kane-san-juan', '2026-09-27T12:00')), true);
ok('Flaming Gorge\'s sheet carries the reciprocal permit rule and the ice-fishing lines rule', [/must have a valid resident fishing license from their state of residence and a reciprocal fishing permit from the other state/.test(sheet('flaming-gorge-reservoir-daggett', '2026-09-27T12:00')), /Ice fishing at Flaming Gorge, Porcupine and Causey reservoirs and Pelican Lake/.test(sheet('flaming-gorge-reservoir-daggett', '2026-09-27T12:00'))], [true, true]);
ok('Strawberry Reservoir\'s sheet carries the rule on filleting trout and salmon', /General rules that name this water[\s\S]*At Strawberry Reservoir, Scofield Reservoir, Lost Creek Reservoir and Panguitch Lake, you may not fillet trout and salmon/.test(sheet('strawberry-reservoir-wasatch', '2026-09-27T12:00')), true);
ok('a water no general rule names has no such section', /General rules that name this water/.test(sheet('moon-lake-duchesne', '2026-09-27T12:00')), false);
ok('every water a general rule names is an entry', R.statewide.rules.concat(R.spear.general).reduce((a, r) => a.concat((r.waters || []).filter(w => !T.FW()[w])), []), []);

/* ---- a place the app could not match never goes without a chip */
ok('Red Pine Lakes: no entry, no related name, no group in Salt Lake County', chipsOf('p10598', '2026-09-27T12:00'), ['No entry by this name']);

/* ---- links a person decided, checked against USGS's maps in the audit of 2026-09-27 */
const lk = id => [T.FPL()[id].w, T.FPL()[id].r || null];
ok('Provo 5th West Angler Access is on Utah Lake\'s Provo Bay, not the Provo River', lk('a186'), [['utah-lake-utah', 'utah-lake-tributaries-utah'], null]);
ok('Mill Race Angler Access touches a tributary west of I-15, so it shows the tributary rules too', [lk('a247'), /CLOSED to the possession of walleye from March 1 through 6 a\.m\. on the first Saturday of May/.test(psheet('a247', '2026-09-27T12:00'))], [[['utah-lake-utah', 'utah-lake-tributaries-utah'], null], true]);
ok('a property 60 m short of the Weber is a hint, not a link', [T.FPL()['a338'].w || [], T.FPL()['a338'].rel], [[], ['weber-river-summit']]);
ok('a place a person has left a note on shows it', /close to where stretch \(b\) begins at the BLM boundary/.test(psheet('a165', '2026-09-27T12:00')), true);
ok('Ogden River Angler Access is two miles below the half mile that is closed', [lk('a180'), chipsOf('a180', '2026-09-27T12:00').indexOf('Closed now')], [[['ogden-river-weber'], 'none'], -1]);
ok('First Dam on the Logan is below both listed stretches, so not shut in February', [lk('p10682'), chipsOf('p10682', '2026-02-01T12:00').indexOf('Closed now'), chipsOf('p10682', '2026-02-01T12:00').indexOf('Part closed')], [[['logan-river-cache'], 'none'], -1, -1]);
ok('Weber accesses between the I-80 bridges are stretch (a)', ['a188', 'a200', 'a265'].map(i => lk(i)[1]), [['a'], ['a'], ['a']]);
ok('Weber accesses below Echo dam and in Morgan, Weber and Davis counties are stretch (b)', ['a112', 'a198', 'a244', 'a202'].map(i => lk(i)[1]), [['b'], ['b'], ['b'], ['b']]);
ok('Weber accesses above Wanship are outside both', ['a269', 'a268', 'a152', 'p10579'].map(i => lk(i)[1]), ['none', 'none', 'none', 'none']);
ok('Echo and Rockport reservoirs are lakes, not stretches of the river', [T.FPL()['p337'].w || [], T.FPL()['p402'].w || []], [[], []]);
ok('Heber Creeper Angler Access is on the lower Provo, stretch (b)', lk('a167'), [['provo-river-summit-utah-wasatch'], ['b']]);
ok('Holmes Creek is Holmes Creek Reservoir', lk('a344'), [['holmes-creek-reservoir-davis'], null]);
ok('the second pond at Sunset Pond is a community water', [lk('p10673'), /The daily limit is 2 fish/.test(psheet('p10673', '2026-09-27T12:00'))], [[['community:sunset-pond-salt-lake'], null], true]);
ok('the Duchesne below the town is under the Green River tributaries entry', [lk('p10669'), /must be immediately killed/.test(psheet('p10669', '2026-09-27T12:00'))], [[['green-river-tributaries-carbon-duchesne-emery-uintah'], null], true]);
ok('no place has a directions point more than 15 miles from its own point', P.places.filter(p => p.nav && box.miles(p.lat, p.lon, p.nav[0], p.nav[1]) > 15).map(p => p.id), []);
ok('every place is inside Utah', P.places.filter(p => !(p.lat > 36.9 && p.lat < 42.1 && p.lon > -114.1 && p.lon < -109.0)).map(p => p.id), []);
ok('every link points at an entry the guidebook has', P.places.reduce((a, p) => a.concat((p.w || []).concat(p.rel || []).filter(w => !T.FW()[w] && !R.community.members.some(m => 'community:' + m.id === w))), []), []);
ok('every stretch letter a place carries is one its entry has', P.places.filter(p => Array.isArray(p.r) && !p.r.every(k => (T.FW()[p.w[0]].reaches || []).some(r => r.key === k))).map(p => p.id), []);
ok('every place outside the listed stretches says why', P.places.filter(p => p.r === 'none' && !(p.why && p.why.length > 20)).map(p => p.id), []);
ok('Pine Lake: related entry, and the group it is an exception to', chipsOf('p10050', '2026-09-27T12:00'), ['See related rules', 'Check group rule']);
ok('no place in the list is without a chip', P.places.filter(p => !T.fPlaceChips(T.FPL()[p.id], at('2026-09-27T12:00')).length).map(p => p.id), []);
ok('a place outside the listed stretches says why', /I-15 up to the Olmstead Diversion lies between stretch \(a\) and stretch \(b\)/.test(psheet('p10574', '2026-09-27T12:00')), true);

/* ---- an emergency change is read like any other layer */
const RC = J(R);
RC.amendments.push({ notice: 'test-fish-lake', url: 'https://wildlife.utah.gov/x.pdf', name: 'Fish Lake', county: 'Sevier', water: 'fish-lake-sevier', from: '2026-09-01', until: '2026-12-31', last_day: '2026-12-31', direction: 'less', replaces: [], sha: 's', rules: [{ id: 't1', text: 'CLOSED TO FISHING.', fx: [{ t: 'closed', scope: 'all' }] }] });
RC.amendments.push({ notice: 'test-strawberry-tribs', url: 'https://wildlife.utah.gov/x.pdf', name: 'Strawberry Reservoir tributaries', county: 'Wasatch', water: 'strawberry-reservoir-tributaries-wasatch', from: '2026-09-01', until: '2026-12-31', last_day: '2026-12-31', direction: 'less', replaces: [], sha: 's', rules: [{ id: 't2', text: 'CLOSED TO FISHING.', fx: [{ t: 'closed', scope: 'all' }] }] });
RC.amendments.push({ notice: 'test-logan', url: 'https://wildlife.utah.gov/x.pdf', name: 'Logan River', county: 'Cache', water: 'logan-river-cache', from: '2026-09-01', until: '2026-12-31', last_day: '2026-12-30', direction: 'more', replaces: [], sha: 's', rules: [{ id: 't3', text: 'No limit on brown trout.', fx: [{ t: 'limit', rows: ['trout'], sp: ['brown trout'] }] }] });
const NC = J(N); ['test-fish-lake', 'test-strawberry-tribs', 'test-logan'].forEach(s => NC.notices.push({ slug: s, title: s, name: s, county: '', text: [['p', 'x']], sha: 's', url: 'https://wildlife.utah.gov/x.pdf' }));
T.set(RC, P, NC);
let fl = stand('fish-lake-sevier', '2026-09-27T12:00');
ok('a change that closes a water shows "Closed now" in the list', [fl.s.closed, T.fChips(fl.s, true, fl.r).map(c => c[1]).indexOf('Closed now') >= 0], [true, true]);
let bh2 = stand('badger-hollow-wasatch', '2026-09-27T12:00');
ok('a change that tightens the rules of the water a stream points to is applied to the stream', [bh2.r.changes.map(c => [c.st.k, c.lent]), bh2.s.closed], [[['on', 'Strawberry Reservoir tributaries']], true]);
const lp = RC.waters.filter(w => w.kind === 'pointer' && w.see.water === 'logan-river-cache').map(w => w.id);
ok('the Logan River has streams that point to it', lp.length > 0, true);
let tf = stand(lp[0], '2026-09-27T12:00');
ok('a change that loosens them is shown and not applied', [tf.r.changes.map(c => c.st.k), tf.r.rows.trout === 'change', /not applied it here/.test(sheet(lp[0], '2026-09-27T12:00'))], [['lent'], false, true]);

/* ---- an index the app does not understand is never passed over */
const RX = J(R);
const mona = RX.waters.find(w => w.id === 'moon-lake-duchesne').reaches[0].rules[0];
[[], [{ t: 'limt', rows: ['trout'] }], [{ t: 'limit' }], [{ t: 'limit', rows: ['trouts'] }], [{ t: 'closed' }], [{ t: 'closed', scope: 'all', w: [['13-01', '04-30']] }], [{ t: 'closed', scope: 'all', w: 'Jan' }], null].forEach(bad => {
  mona.fx = bad; T.set(RX, P, N);
  const r = T.fResolve('moon-lake-duchesne', at('2026-09-27T12:00'), null);
  ok('index ' + JSON.stringify(bad) + ' is shown as not sorted', [r.unsorted, r.all, /Not sorted - read it/.test(sheet('moon-lake-duchesne', '2026-09-27T12:00'))], [true, true, true]);
});
const RA = J(R); RA.amendments.find(a => /palisade/.test(a.notice)).last_day = 'soon';
T.set(RA, P, N);
ok('a change whose dates cannot be read is not applied', T.fAmendState(T.FAM()['palisade-reservoir-sanpete'][0], at('2026-09-27T12:00')).k, 'held');

/* ---- places built against another build of the rules */
const PX = J(P); PX._rules_shape = 'somethingelse00';
T.set(R, PX, N);
ok('places from another build are not matched to rules', [T.linked(), T.FPL()['p396'].w, T.FPL()['p10574'].r], [false, [], null]);
ok('...and every sheet says so', /from different builds/.test(sheet('bear-lake-rich', '2026-09-27T12:00')), true);
ok('...and the water can still be opened by name', /Limit 20 crappie/.test(sheet('pineview-reservoir-weber', '2026-12-31T12:00')), true);
T.set(R, null, N);
box.T.fish.now = '2026-09-27T12:00';
ok('with no places on the phone the finder answers without falling over', [/not on this phone yet/.test(T.fishAnswer(T.fishParse('trout near the cabin'))), T.sheetFishWater('bear-lake-rich').length > 500, T.vFish().length > 500, T.cardFish().length > 100], [true, true, true, true]);
box.T.fish.now = null;

/* ---- every warning travels with the sheet and with the finder */
T.set(R, P, N2);
let bs = sheet('bear-lake-rich', '2026-09-27T12:00');
ok('an unread notice is named on a sheet for another water', [/not yet built into these rules/.test(bs), /Test Lake \(Wayne County\)/.test(bs)], [true, true]);
ok('a replaced guidebook is named on every sheet', /replaced the guidebook file/.test(bs), true);
ok('a place sheet carries them too', [/not yet built into these rules/.test(psheet('a244', '2026-09-27T12:00')), /replaced the guidebook file/.test(psheet('p396', '2026-09-27T12:00'))], [true, true]);
box.T.fish.now = '2026-09-27T12:00';
box.fq.text = 'strawberry reservoir rules'; box.fq.parsed = box.fParse('strawberry reservoir rules');
ok('...and so does an answer from the hunt finder', [/not yet built into these rules/.test(box.vFind()), /replaced the guidebook file/.test(box.vFind())], [true, true]);
box.T.fish.now = null;
ok('Pineview, once UDWR stops listing its notice, shows the guidebook rule on its sheet', [/UDWR no longer lists this notice/.test(sheet('pineview-reservoir-weber', '2026-09-27T12:00')), /Replaced until/.test(sheet('pineview-reservoir-weber', '2026-09-27T12:00'))], [true, false]);
T.set(R, P, N3);
ok('an unread notice for this very water is printed in full on its sheet', /UDWR has posted a change for this water that is not built into the rules below/.test(sheet('strawberry-reservoir-wasatch', '2026-09-27T12:00')), true);
ok('...and named on its neighbours\' sheets', /Strawberry Reservoir \(Wasatch County\)/.test(sheet('strawberry-river-duchesne-wasatch', '2026-09-27T12:00')), true);
ok('...and on the row in the list', T.fChips(stand('strawberry-reservoir-wasatch', '2026-09-27T12:00').s, false, stand('strawberry-reservoir-wasatch', '2026-09-27T12:00').r).map(c => c[1])[0], 'New notice - not built in');
const N4 = J(N); N4.sha = 'edited0000000000'; N4.other.push(['p', 'Page 30: the limit at Test Lake is 2 trout.']);
T.set(R, P, N4);
ok('an edit to UDWR\'s list that is not a notice is flagged', [T.fNotices().list, /UDWR's list of fishing changes is not the list these rules were built from/.test(sheet('bear-lake-rich', '2026-09-27T12:00')), /Page 30: the limit at Test Lake is 2 trout\./.test(sheet('bear-lake-rich', '2026-09-27T12:00'))], [true, true, true]);
T.set(R, P, N);
ok('today\'s list matches the day the rules were built', [T.fNotices().list, R._notices_sha === N.sha], [false, true]);
const N5 = J(N); N5.last_ok = '2026-09-20T11:15:00+00:00';
T.set(R, P, N5);
ok('a list last read a week ago is flagged on every sheet and on Today', [/was last read Sep 20, 2026/.test(sheet('bear-lake-rich', '2026-09-27T12:00')), (() => { box.T.fish.now = '2026-09-27T12:00'; const h = T.cardFish(); box.T.fish.now = null; return /has not been read lately/.test(h); })()], [true, true]);
T.set(R, P, N);
box.T.fish.now = '2026-09-27T12:00';
ok('nothing is flagged on an ordinary day', T.fStale(at('2026-09-27T12:00'), null), '');
box.T.fish.now = null;

/* ---- a search that finds nothing must not read as "statewide" */
box.T.fish.now = '2026-09-27T12:00';
T.fishRun('is zzyzx open');
let vf = T.vFish();
ok('"is zzyzx open": says nothing matched, and does not say statewide rules apply', [/Nothing in the guidebook's list matched/.test(vf), /is under the statewide rules/.test(vf)], [true, false]);
T.fishRun('is minersville open');
ok('"is minersville open" finds the reservoir', [box.T.fish.parsed && box.T.fish.parsed.water.needle, />Minersville Reservoir</.test(T.vFish())], ['minersville', true]);
T.fishRun('deseret reservoir permit');
ok('"deseret reservoir permit" finds the reservoir', box.T.fish.parsed && box.T.fish.parsed.water.needle, 'deseret reservoir');
T.fishRun('archery lake powell');
ok('"archery lake powell" finds the lake', box.T.fish.parsed && box.T.fish.parsed.water.needle, 'lake powell');
ok('words that are not names are dropped from a search', T.fTokens('is the Provo River open today'), ['provo', 'river']);
box.T.fish.q = ''; box.T.fish.parsed = null; box.T.fish.mode = 'near'; box.T.fish.now = null;

/* ---- whose sentence is it */
ok('"deer hunting in browns park" is a hunt, not brown trout', [fp('deer hunting in browns park'), hp('deer hunting in browns park')], [null, 'hunt:deer']);
ok('"is deer season open near fish lake" is a hunt', [fp('is deer season open near fish lake'), hp('is deer season open near fish lake')], [null, 'hunt:deer+fish lake']);
ok('"elk rules at strawberry reservoir" is a hunt', [fp('elk rules at strawberry reservoir'), hp('elk rules at strawberry reservoir')], [null, 'hunt:elk+strawberry reservoir']);
ok('"ducks at fish springs" is a hunt', [fp('ducks at fish springs'), hp('ducks at fish springs')], [null, 'hunt:duck']);
ok('"do I need a permit to fish deseret reservoir" is fishing', fp('do I need a permit to fish deseret reservoir'), [null, null, 'deseret reservoir', null]);
ok('"walleye at deer creek" is fishing, and finds the reservoir by the short form of its name', [fp('walleye at deer creek')[0], fp('walleye at deer creek')[2], T.fishParse('walleye at deer creek').water.refs.some(r => r.w === 'deer-creek-reservoir-wasatch')], ['walleye', 'deer creek', true]);
ok('a hunting word beats a fish\'s name: "deer hunting near rainbow"', fp('deer hunting near rainbow'), null);
ok('"browns near the cabin" is brown trout', fp('browns near the cabin'), ['brown', 'heber', null, null]);
T.set(null, null, null);
ok('before the rules have loaded, a fishing sentence is held, not sent to the hunt finder', [!!(T.fishParse('fishing at sheep creek lake') || {}).pending, !!(T.fishParse('bass at quail creek reservoir') || {}).pending, T.fishParse('elk by my cabin')], [true, true, null]);
ok('...and the finder says it is loading', /Loading the fishing rules|not on this phone yet/.test(T.fishAnswer(T.fishParse('bass at quail creek reservoir'))), true);
T.set(R, P, N);

/* ================= added after the second code review, 2026-09-28 ================= */
T.set(R, P, N); box.T.fish.now = null; CLOCK = FIXED;

/* ---- spearfishing: whole names only */
ok('the Weber River is not on the spearfishing lists: "Fish Lake (Weber River drainage)" names Fish Lake', [T.fSpearFor('weber-river-summit', 'Weber River', ['Summit']).length, /The app did not find this water in the guidebook's lists of waters open to spearfishing/.test(sheet('weber-river-summit', '2026-09-27T12:00')), /Named as/.test(sheet('weber-river-summit', '2026-09-27T12:00'))], [0, true, false]);
ok('no Weber place is told it is on the lists', P.places.filter(p => (p.w || []).indexOf('weber-river-summit') >= 0 && /Named as/.test(T.sheetFishPlace(T.FPL()[p.id]))).map(p => p.id), []);
ok('Fish Lake in Sevier County has its own entry, and is not the Fish Lake of the Uintas', T.fSpearFor('fish-lake-sevier', 'Fish Lake', ['Sevier']).map(x => [x.sec.id, x.e.name]), [['except', 'Fish Lake']]);
ok('Spirit Lake, Daggett County, is one of the 17 Uinta lakes the list names', T.fSpearFor(null, 'Spirit Lake', ['Daggett']).map(x => [x.sec.id, x.e.name]), [['open', 'Uinta Mountains']]);
ok('Smith and Morehouse Reservoir is one name, not two', T.fSpearFor(null, 'Smith and Morehouse Reservoir', ['Summit']).map(x => x.e.name), ['Uinta Mountains']);
ok('a lake of the same name in a county the list does not cover is not matched', T.fSpearFor(null, 'Spirit Lake', ['Sevier']).length, 0);
ok('the Uinta list holds 17 names and the Utah Lake tributaries entry 9', R.spear.sections.reduce((a, x) => a.concat(x.entries.filter(e => e.named).map(e => [e.name, e.named.length])), []), [['Uinta Mountains', 17], ['Utah Lake tributaries', 9]]);

/* ---- a tributary rule that reaches into the lake (Bear Lake tributaries, p. 29) */
ok('Bear Lake is offered the rule for its tributaries', grp('Bear Lake', ['Rich'], 'lake'), ['bear-lake-tributaries-rich']);
ok('...and its sheet prints the part that reaches 1,000 feet into the lake', /Group rules that may also cover this water[\s\S]*that area extending from the mouth out into the lake 1,000 feet, or as buoyed/.test(sheet('bear-lake-rich', '2026-05-20T12:00')), true);
ok('...and its row in the list says to check it', chipsOf('p255', '2026-05-20T12:00').indexOf('Check group rule') >= 0, true);
ok('Utah Lake is offered the Utah Lake tributaries', grp('Utah Lake', ['Utah'], 'lake'), ['utah-lake-tributaries-utah']);
ok('Duck Fork Reservoir is offered "Duck Fork Creek and other tributaries to Duck Fork Reservoir"', grp('Duck Fork Reservoir', ['Sanpete'], 'lake'), ['duck-fork-creek-and-other-tributaries-to-duck-fork-reservoir-sanpete']);
ok('another lake in the same county is still not offered them', grp('Tibble Fork Reservoir', ['Utah'], 'lake'), []);

/* ---- UDWR's list edited while another notice is also unread */
const N6 = J(N); N6.sha = 'edited0000000000'; N6.other.push(['p', 'Correction: the limit at Strawberry Reservoir is 2 trout.']);
N6.notices.push({ slug: 'emergency-change-2026-10-02-test-lake', title: 'Test Lake (Wayne County)', name: 'Test Lake', county: 'Wayne', text: [['p', 'x']], sha: 'x', url: 'https://wildlife.utah.gov/x.pdf' });
T.set(R, P, N6);
ok('a correction on UDWR\'s list is shown even when a notice is unread too', [T.fNotices().list, T.fNotices().unread.length, /Correction: the limit at Strawberry Reservoir is 2 trout\./.test(sheet('strawberry-reservoir-wasatch', '2026-09-27T12:00'))], [true, 1, true]);

/* ---- a signed notice replaced at the same address */
const N7 = J(N); N7.notices.find(n => /pineview/.test(n.slug)).pdf_sha = 'replaced00000000';
T.set(R, P, N7);
ok('a replaced signed notice counts as a reworded one', [T.fHeld()['emergency-change-2026-07-02-pineview-reservoir'], T.fAmendState(am('pineview-reservoir-weber'), at('2026-09-27T12:00')).k], ['changed', 'held']);
box.T.fish.now = '2026-09-27T12:00'; box.T.fish.mode = 'now';
ok('...and the Fish tab prints what the notice says today', /or replaced the signed notice, since it was read in\.<\/b>[\s\S]*It reads:[\s\S]*Pineview Reservoir \(Weber County\)/.test(T.vFish()), true);
box.T.fish.now = null; box.T.fish.mode = 'near';
T.set(R, P, N);

/* ---- an emergency change that shuts a water reaches every stretch under it */
const RD = J(R);
RD.amendments.push({ notice: 'test-deseret', url: 'https://wildlife.utah.gov/x.pdf', name: 'Deseret Reservoir', county: 'Tooele', water: 'deseret-reservoir-tooele', from: '2026-06-01', until: '2026-12-31', last_day: '2026-12-31', direction: 'less', replaces: [], sha: 's', rules: [{ id: 'd1', text: 'CLOSED TO FISHING.', fx: [{ t: 'closed', scope: 'all' }] }] });
RD.amendments.push({ notice: 'test-tribs', url: 'https://wildlife.utah.gov/x.pdf', name: 'Strawberry Reservoir tributaries', county: 'Wasatch', water: 'strawberry-reservoir-tributaries-wasatch', from: '2026-07-01', until: '2026-08-31', last_day: '2026-08-31', direction: 'less', replaces: [], sha: 's', rules: [{ id: 'd2', text: 'CLOSED July 1 through Aug. 31.', fx: [{ t: 'closed', scope: 'all', w: [['07-01', '08-31']] }] }] });
const ND = J(N); ['test-deseret', 'test-tribs'].forEach(x => ND.notices.push({ slug: x, title: x, name: x, county: '', text: [['p', 'x']], sha: 's', url: 'https://wildlife.utah.gov/x.pdf' }));
T.set(RD, P, ND);
let dz = sheet('deseret-reservoir-tooele', '2026-06-15T12:00');
ok('Deseret shut by a change in June: the stretch says so, and promises no opening and no last day open', [layer('deseret-reservoir-tooele', '2026-06-15T12:00').stand.closed, /Shut by the emergency change above/.test(dz), /Closed by the change above/.test(dz), /Open today|Open now|Last day open|Opens /.test(dz)], [true, true, true, false]);
let sb = layer('strawberry-reservoir-tributaries-wasatch', '2026-07-05T12:00', 'b').stand;
ok('Strawberry tributaries (b), shut to Aug 31 by a change: opens Sept 1, not July 11', [sb.closed, ymd(sb.opens), hm(sb.opens)], [true, '2026-09-01', '00:00']);
T.set(R, P, N);

/* ---- places and rules from different builds */
T.set(R, PX, N);
ok('with places from another build, no row says "No entry by this name"', [chipsOf('p396', '2026-09-27T12:00'), chipsOf('a244', '2026-09-27T12:00'), /has not matched this place to its rules/.test(psheet('p396', '2026-09-27T12:00')), /Statewide limits/.test(psheet('p396', '2026-09-27T12:00'))], [['Not matched - look it up by water'], ['Not matched - look it up by water'], true, false]);
T.set(R, P, N);

/* ---- a water the app does not know */
ok('"trout limit at Trial Lake": the app says it does not know Trial Lake', [T.fishParse('trout limit at Trial Lake', true).unknown, /The app does not know a water called "trial lake"/.test(T.fishAnswer(T.fishParse('trout limit at Trial Lake', true)))], ['trial lake', true]);
ok('"trout near the cabin" names no water, so nothing is said to be unknown', T.fishParse('trout near the cabin', true).unknown, undefined);
ok('"bass at quail creek reservoir" names a water the app knows', T.fishParse('bass at quail creek reservoir', true).unknown, undefined);

/* ---- fish the list did not know (statewide table, p. 7: Sacramento perch 10, roundtail chub 2, yellow perch 50) */
ok('"sacramento perch limit" is Sacramento perch, 10, not yellow perch, 50', [fp('sacramento perch limit')[0], /Statewide limit: Sacramento perch[\s\S]{0,200}<span class="v">10</.test(T.fishAnswer(T.fishParse('sacramento perch limit', true)))], ['sacperch', true]);
ok('"yellow perch" and "perch" are still yellow perch', [fp('yellow perch near home')[0], fp('perch near home')[0]], ['perch', 'perch']);
ok('"roundtail chub" and "crayfish" are known', [fp('roundtail chub limit')[0], fp('crayfish near home')[0]], ['roundtail', 'crayfish']);

/* ---- community waters under By water */
box.T.fish.now = '2026-12-05T12:00'; box.T.fish.mode = 'rules'; box.T.fish.q = 'spanish oaks'; box.T.fish.parsed = null;
ok('Spanish Oaks Reservoir, Dec 5: its row under By water says Closed now', /Spanish Oaks Reservoir<\/span>[\s\S]{0,260}Closed now/.test(T.vFish()), true);
box.T.fish.q = 'salem pond';
ok('Salem Pond, Dec 5: its row does not', /Closed now/.test(T.vFish()), false);
box.T.fish.now = null; box.T.fish.mode = 'near'; box.T.fish.q = '';

/* ---- outside the guidebook's year nothing is worked out from its dates */
let ny = sheet('deseret-reservoir-tooele', '2027-06-15T12:00');
ok('in 2027 a sheet carries no tag worked out from 2026 dates', [/2026 is over/.test(ny), /Open today|Open now|Closed now|In force today|Not today|Last day open|Opens /.test(ny)], [true, false]);
ok('...and no kokanee box that says "today"', /in force today: kokanee/i.test(sheet('strawberry-reservoir-wasatch', '2027-10-01T12:00')), false);
box.T.fish.now = '2027-10-01T12:00'; box.T.fish.mode = 'now';
ok('...on the In force screen either', [/Kokanee may not be kept anywhere in Utah today/.test(T.vFish()), /2026 is over/.test(T.vFish())], [false, true]);
box.T.fish.now = '2026-10-01T12:00';
ok('...while on Oct. 1, 2026 it does say so', /Kokanee may not be kept anywhere in Utah today/.test(T.vFish()), true);
box.T.fish.now = null; box.T.fish.mode = 'near';

/* ---- whose sentence is it, again */
ok('"is duck fork open" is about Duck Fork, not ducks', [fp('is duck fork open'), hp('is duck fork open')], [[null, null, 'duck fork', null], 'fish:duck fork']);
ok('"ducks at duck fork" is a hunt that also names a water', hp('ducks at duck fork'), 'hunt:duck+duck fork');
ok('"fishing in carbon county" is the county', fp('fishing in carbon county'), [null, null, null, 'Carbon']);
ok('"fishing in san juan county" is the county, not the San Juan River', fp('fishing in san juan county'), [null, null, null, 'San Juan']);
ok('"san juan river rules" is the river', fp('san juan river rules'), [null, null, 'san juan river', null]);
ok('"carbon county community fishery" is the pond of that name', fp('carbon county community fishery rules'), [null, null, 'carbon county community fishery', null]);
ok('"trout in wasatch county" keeps both', fp('trout in wasatch county'), ['trout', null, null, 'Wasatch']);

/* ================= added after the third check, 2026-09-28 ================= */
T.set(R, P, N); box.T.fish.now = null; CLOCK = FIXED;
const ans = s => T.fishAnswer(T.fishParse(s, true));

/* ---- fish the guidebook says must be let go (p. 16): never answered with a limit */
['can i keep a june sucker', 'razorback sucker limit', 'humpback chub', 'bonytail limit', 'colorado pikeminnow', 'woundfin', 'virgin river chub'].forEach(q => {
  ok('"' + q + '" is answered with the list of fish that must be released, and no limit', [!!T.fishParse(q, true).protected && T.fishParse(q, true).protected.sure, /must be let go/.test(ans(q)), /you must release them \(alive\) immediately/.test(ans(q)), /Statewide limit|No limit/.test(ans(q))], [true, true, true, false]);
});
ok('"sucker limit" and "utah chub" do not say which fish, so they get the list and no limit', ['sucker limit', 'utah chub', 'chubs near home'].map(q => [T.fishParse(q, true).protected.sure, /cannot tell which you mean/.test(ans(q)), /Statewide limit|No limit/.test(ans(q))]), [[false, true, false], [false, true, false], [false, true, false]]);
ok('"roundtail chub limit" has a row of its own: 2', [fp('roundtail chub limit')[0], T.fishParse('roundtail chub limit', true).protected, /Statewide limit: Roundtail chub[\s\S]{0,260}<span class="v">2</.test(ans('roundtail chub limit'))], ['roundtail', undefined, true]);
ok('the hunt finder hands a protected fish to fishing', hp('can i keep a june sucker'), 'fish:');
ok('"bullhead catfish" is bullhead, 24, not channel catfish, 8', [fp('bullhead catfish limit')[0], fp('channel catfish near home')[0], fp('catfish near home')[0]], ['bullhead', 'catfish', 'catfish']);

/* ---- spearfishing: a heading over a list is not a water */
const uinta = P.places.filter(p => /^Uinta Mountains,/.test(p.n));
ok('there are 19 places called "Uinta Mountains, ..."', uinta.length, 19);
ok('none of them is told the guidebook names it as open to spearfishing', uinta.filter(p => /Named as|Waterbodies open to spearfishing\.<\/b>/.test(T.sheetFishPlace(T.FPL()[p.id])) || T.fSpearFor(null, p.n.split(',')[0], [p.c]).length).map(p => p.n), []);
ok('...each is told the app did not find it on the lists, or, on the Provo, that carp and chub may not be speared there', uinta.filter(p => !/did not find this water in the guidebook's lists|except for the Provo River and Provo River Delta/.test(T.sheetFishPlace(T.FPL()[p.id]))).map(p => p.n), []);
ok('the two Uinta lakes that are on the list still match', ['p10058', 'p10671'].map(i => /Named as/.test(T.sheetFishPlace(T.FPL()[i]))), [true, true]);
ok('the spearfishing lists are by county: the upper Provo in Summit County and Provo Canyon in Wasatch County are not shown the Utah County entry', ['p10577', 'a167'].map(i => /Named as<\/span><span class="ftext">Utah Lake tributaries/.test(T.sheetFishPlace(T.FPL()[i]))), [false, false]);
ok('...the Provo River\'s own sheet, which takes in Utah County, is', /Named as<\/span><span class="ftext">Utah Lake tributaries/.test(sheet('provo-river-summit-utah-wasatch', '2026-09-27T12:00')), true);
ok('Fish Lake is printed with "(Weber River drainage)", and that is kept', R.spear.sections[0].entries.find(e => e.name === 'Uinta Mountains').named.find(x => x.n === 'Fish Lake'), { n: 'Fish Lake', w: null, q: 'Weber River drainage' });
ok('a Fish Lake in Summit County would not be matched by name alone', T.fSpearFor(null, 'Fish Lake', ['Summit']).length, 0);
/* For every place: each spearfishing entry its sheet shows must be one the place has a
   claim to, worked out here from the data and not by the app: the entry is for a water
   the place is linked to (or that water's "See ..." leads to), or it names the place, or
   one of its linked waters, in its checked list of names; and the county must agree. */
ok('no place is shown a spearfishing entry it has no claim to', (() => {
  const key = x => String(x).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim(), bad = [];
  P.places.forEach(p => {
    const h = T.sheetFishPlace(T.FPL()[p.id]), ids = [];
    (p.w || []).forEach(w => { ids.push(w); const e = T.FW()[w]; if (e && e.kind === 'pointer') ids.push(e.see.water); });
    const names = [p.n.split(',')[0]].concat(ids.map(i => (T.FW()[i] || {}).name || '')).map(key);
    R.spear.sections.forEach(sec => sec.entries.forEach(e => {
      const shown = h.indexOf('Named as</span><span class="ftext">' + box.esc(e.name) + ', ' + box.esc(e.counties.join(', '))) >= 0;
      if (!shown) return;
      const near = e.counties.indexOf(p.c) >= 0;
      const claim = near && ((e.water && ids.indexOf(e.water) >= 0) || (!e.named && names.indexOf(key(e.name)) >= 0) || (e.named || []).some(x => !x.q && ((x.w && ids.indexOf(x.w) >= 0) || names.indexOf(key(x.n)) >= 0)));
      if (!claim) bad.push(p.n + ' <- ' + e.name);
    }));
  });
  return bad.slice(0, 6); })(), []);

/* ---- a water known only from a notice, read in after the places were built */
const RN = J(R);
RN.waters.push({ id: 'electric-lake-emery', name: 'Electric Lake', counties: ['Emery'], kind: 'notice', reaches: [] });
RN.amendments.push({ notice: 'test-electric', url: 'https://wildlife.utah.gov/x.pdf', name: 'Electric Lake', county: 'Emery', water: 'electric-lake-emery', from: '2026-09-01', until: '2026-12-31', last_day: '2026-12-31', direction: 'less', replaces: [], sha: 's', rules: [{ id: 'e1', text: 'CLOSED TO FISHING.', fx: [{ t: 'closed', scope: 'all' }] }] });
const NN = J(N); NN.notices.push({ slug: 'test-electric', title: 'Electric Lake (Emery County)', name: 'Electric Lake', county: 'Emery', text: [['p', 'x']], sha: 's', url: 'https://wildlife.utah.gov/x.pdf' });
ok('Electric Lake has a place and no guidebook entry', [(P.places.find(p => p.id === 'p502') || {}).n, (P.places.find(p => p.id === 'p502') || {}).w || null], ['Electric Lake', null]);
T.set(RN, J(P), NN);
ok('once its closure is read in, its place shows it, though the places were not rebuilt', [T.FPL()['p502'].w, chipsOf('p502', '2026-09-27T12:00').indexOf('Closed now') >= 0, /CLOSED TO FISHING/.test(psheet('p502', '2026-09-27T12:00'))], [['electric-lake-emery'], true, true]);
T.set(R, P, N);

/* ---- a closure that is posted and has not started */
const RL2 = J(R);
RL2.amendments.push({ notice: 'test-later', url: 'https://wildlife.utah.gov/x.pdf', name: 'Deseret Reservoir', county: 'Tooele', water: 'deseret-reservoir-tooele', from: '2026-10-05', until: '2026-10-20', last_day: '2026-10-20', direction: 'less', replaces: [], sha: 's', rules: [{ id: 'l1', text: 'CLOSED TO FISHING.', fx: [{ t: 'closed', scope: 'all' }] }] });
const NL2 = J(N); NL2.notices.push({ slug: 'test-later', title: 'x', name: 'x', county: '', text: [['p', 'x']], sha: 's', url: 'https://wildlife.utah.gov/x.pdf' });
T.set(RL2, P, NL2);
let dl = layer('deseret-reservoir-tooele', '2026-09-27T12:00').stand;
ok('Deseret, a closure posted for Oct 5 to Oct 20, seen on Sept 27: open, last day open Oct 4', [dl.closed, ymd(dl.closes), /Last day open Oct 4, 2026/.test(sheet('deseret-reservoir-tooele', '2026-09-27T12:00')), /Last day open Oct 31/.test(sheet('deseret-reservoir-tooele', '2026-09-27T12:00'))], [false, '2026-10-05', true, false]);
dl = layer('deseret-reservoir-tooele', '2026-10-10T12:00').stand;
ok('...on Oct 10: shut by the change, opens Oct 21, and not "for the rest of 2026"', [dl.closed, dl.byChange, ymd(dl.opens), /Opens Oct 21, 2026/.test(sheet('deseret-reservoir-tooele', '2026-10-10T12:00')), /rest of 2026/.test(sheet('deseret-reservoir-tooele', '2026-10-10T12:00'))], [true, true, '2026-10-21', true, false]);
dl = layer('deseret-reservoir-tooele', '2026-10-25T12:00').stand;
ok('...on Oct 25: open again until Oct 31, the guidebook\'s own last day', [dl.closed, /Last day open Oct 31, 2026/.test(sheet('deseret-reservoir-tooele', '2026-10-25T12:00'))], [false, true]);
T.set(R, P, N);

/* ---- a reworded notice is carried to every sheet, with what it says today */
const N8 = J(N); N8.sha = 'edited0000000000';
const oc = N8.notices.find(n => /otter-creek/.test(n.slug)); oc.sha = 'reworded00000000'; oc.text.push(['p', 'Scofield Reservoir: CLOSED to fishing until further notice.']);
T.set(R, P, N8);
let sc = sheet('scofield-reservoir-carbon-utah', '2026-09-27T12:00');
ok('Scofield\'s sheet prints a reworded notice for another water, because its new words may be about Scofield', [/UDWR has reworded its notice for Otter Creek Reservoir/.test(sc), /Scofield Reservoir: CLOSED to fishing until further notice\./.test(sc), /is not the list these rules were built from/.test(sc)], [true, true, true]);
T.set(R, P, N);

/* ---- what a change says about spearfishing */
const RS = J(R);
RS.amendments.push({ notice: 'test-spear', url: 'https://wildlife.utah.gov/x.pdf', name: 'Moon Lake', county: 'Duchesne', water: 'moon-lake-duchesne', from: '2026-09-01', until: '2026-12-31', last_day: '2026-12-31', direction: 'less', replaces: [], sha: 's', rules: [{ id: 's1', text: 'Underwater spearfishing is prohibited.', fx: [{ t: 'method' }] }] });
const NS = J(N); NS.notices.push({ slug: 'test-spear', title: 'x', name: 'x', county: '', text: [['p', 'x']], sha: 's', url: 'https://wildlife.utah.gov/x.pdf' });
T.set(RS, P, NS);
ok('a change that forbids spearfishing is not said to open the water to it', [/opens this water to spearfishing/.test(sheet('moon-lake-duchesne', '2026-09-27T12:00')), /An emergency change above speaks to spearfishing at this water\. Read it\./.test(sheet('moon-lake-duchesne', '2026-09-27T12:00'))], [false, true]);
T.set(R, P, N);
ok('Vernon Reservoir: "is open to underwater spearfishing for all game fish" is said to open it', /An emergency change above opens this water to spearfishing while it is in force/.test(sheet('vernon-reservoir-tooele', '2026-09-27T12:00')), true);

/* ---- no row without a chip, on any day */
ok('every water and community water has a chip on Jan 15, May 1, Sept 27 and Dec 15', ['2026-01-15T12:00', '2026-05-01T12:00', '2026-09-27T12:00', '2026-12-15T12:00'].map(d => R.waters.map(w => w.id).concat(R.community.members.map(m => 'community:' + m.id)).filter(id => { const r = T.fResolve(id, at(d), null); box.T.fish.now = d; const c = T.fChips(T.fSummary(r), r.changes.some(x => x.st.k === 'on'), r); box.T.fish.now = null; return !c.length; }).length), [0, 0, 0, 0]);

/* ---- outside the guidebook's year the table is printed as printed */
ny = sheet('moon-lake-duchesne', '2027-06-15T12:00');
ok('in 2027 the statewide table is not split into changed and unchanged', [/As printed for 2026/.test(ny), /Unchanged here|Changed at this water|not in force today/.test(ny)], [true, false]);

/* ---- a stretch of a group that points elsewhere */
ok('Utah Lake: the offered tributaries group sends its Provo River stretch to the Provo River', /Group rules that may also cover this water[\s\S]*\(b\) Provo River[\s\S]{0,200}See Provo River/.test(sheet('utah-lake-utah', '2026-09-27T12:00')), true);

/* ---- hunting sentences a water's short name must not take apart */
ok('"tushar mountain goat hunt" and "wasatch mountain goat" are mountain goat', [hp('tushar mountain goat hunt'), hp('wasatch mountain goat')], ['hunt:mountain goat', 'hunt:mountain goat']);
ok('"mountain goats near willard peak" is not a fishing question', /^hunt:/.test(hp('mountain goats near willard peak')), true);
ok('"is duck fork open" is still about Duck Fork', hp('is duck fork open'), 'fish:duck fork');
ok('"spearfishing at pineview" and "can i spearfish at yuba reservoir" are fishing', [hp('spearfishing at pineview'), hp('can i spearfish at yuba reservoir')], ['fish:pineview', 'fish:yuba reservoir']);
ok('"june sucker at utah lake" gets the list of protected fish and then Utah Lake', [/June sucker is on the guidebook's list of fish that must be let go/.test(ans('june sucker at utah lake')), />Utah Lake</.test(ans('june sucker at utah lake')), /Statewide limit/.test(ans('june sucker at utah lake'))], [true, true, false]);
ok('"virgin river chub" is the fish, "virgin river rules" is the river', [T.fishParse('virgin river chub', true).protected.name, T.fishParse('virgin river chub', true).water, fp('virgin river rules')[2]], ['Virgin River chub', null, 'virgin river']);
ok('"middle provo rules" finds the two places on the middle Provo', [fp('middle provo rules')[2], T.fishParse('middle provo rules', true).water.refs.map(r => r.p).sort()], ['middle provo', ['p10573', 'p223']]);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
