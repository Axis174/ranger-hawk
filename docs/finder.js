/* Ranger Hawk - hunt finder. "I want to hunt elk near home" -> the hunts that
   exist there this year, with dates, permit type and last year's draw odds.
   Works with no signal: it reads the place, the species and the weapon out of
   the sentence, finds the hunt units under that place with the unit shapes the
   app already carries, then matches them to UDWR's 2026 hunt lists and the draw
   results. It asks a question when something is missing rather than guessing.
   Loaded after app.js; shares its globals. */
'use strict';

let HU = null;                         // hunt_units_2026.json
let fq = { text: '', sp: null, wp: null, place: null, pt: null, units: null, ask: null };
/* The first match wins, so the narrow name is tested before the wide one that
   contains it: "mountain goat" before the "goat" of pronghorn, "bull moose"
   before the "bull" of elk. Every alternative is anchored at both ends, or a
   stray "ram" inside another word picks bighorn sheep. */
const F_SPECIES = [['mountain goat', /\b(mountain|mtn)\s*goat\b/], ['moose', /\bmoose\b/], ['bison', /\b(bison|buffalo)\b/],
  ['sheep', /\b(sheep|bighorn|rams?)\b/], ['pronghorn', /\b(pronghorn|antelope|speed\s*goat|goat)\b/],
  ['elk', /\b(elk|bull|spike|wapiti)\b/], ['deer', /\b(deer|buck|muley|mule)\b/]];
const F_WEAPON = [['archery', /\b(arch\w*|bow\w*|compound)\b/], ['muzzleloader', /\b(muzz\w*|smoke\s*pole|black\s*powder)\b/],
  ['rifle', /\b(rifle|any legal|alw|gun|centerfire)\b/]];
const F_LABEL = { elk: 'Elk', deer: 'Deer', pronghorn: 'Pronghorn', moose: 'Moose', sheep: 'Bighorn sheep', 'mountain goat': 'Mountain goat', bison: 'Bison' };

/* Compare words, not characters, so "Wasatch, 7 points" and the unit name
   "Wasatch Mtns" can meet in the middle: punctuation becomes a space. */
const fWords = s => ' ' + String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
const F_RANGE = /\s+(mtns?|mountains?)$/i;
/* Utah place names that contain an animal word. "deer near antelope island" must not read
   as pronghorn just because the island is called Antelope, so these phrases are removed
   before the species match - and left alone for the place match, where they belong. */
const F_PLACE_NOISE = /\b(antelope island|antelope flat|deer creek|deer valley|bear lake|bear river|elk ridge|goose creek|swan creek|pigeon hollow)\b/g;                 // nobody says "Wasatch Mtns" out loud
/* Every way a hunt unit can be named in a sentence, longest needle first. */
function fUnitNames() {
  const out = [];
  for (const base of new Set((UNITS || []).map(u => u.n.split(',')[0]))) {
    out.push([fWords(base), base]);
    const short = base.replace(F_RANGE, '');
    if (short !== base && short.trim()) out.push([fWords(short), base]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

function fLoad() {
  if (typeof fishLoad === 'function') fishLoad();
  if (!HU) fetch('data/' + STATE + '/hunt_units_2026.json').then(r => r.json()).then(j => { HU = j; if (tab === 'seasons') render(); }).catch(() => { HU = { hunts: {} }; });
  if (!ODDS) loadOdds();
  if (!UNITS) fetch('data/' + STATE + '/units_geo.json').then(r => r.json()).then(j => { UNITS = j.units; if (tab === 'seasons') render(); }).catch(() => {});
}
/* What a sentence says to hunt, read from text that already has its place names taken out:
   { gap, bird, sp }. The one place the hunt finder's species words are tested; the Fish box
   asks it too (fHuntOffer in fishing.js), so there is no second word list. */
function fGameIn(st) {
  const o = { gap: null, bird: null, sp: null };
  for (const g of F_BIRD_GAPS) if (g[1].test(st)) { o.gap = g; break; }
  if (!o.gap) for (const b of F_BIRDS) if (b[2].test(st)) { o.bird = b; break; }
  if (!o.gap && !o.bird) for (const [k, re] of F_SPECIES) if (re.test(st)) { o.sp = k; break; }
  return o;
}
/* A water as a place to hunt around. Only STILL waters (a lake, a reservoir, a pond) can be:
   a river or creek crosses many hunt units and has no one point. A place counts only when the
   fishing data marks it a lake or pond, it has a point, and its own name (before any comma, with
   any bracket taken out) says lake, reservoir or pond - some "lake" places in the data are river
   stretches ("Provo River, Middle, from Deer Creek Reservoir...") or areas ("Uinta Mountains,
   Dry Gulch") and must never become a spot. The label is the place's name and county exactly as
   the Fish screen writes them. */
const F_STILL_WORD = /\b(reservoirs?|lakes?|ponds?|res)\b/g;
const F_MOVING_WORD = /\b(rivers?|creeks?|streams?|forks?|tributar(?:y|ies)|inlets?|inflows?|canals?|sloughs?)\b/g;
const fPlaceBase = p => String(p.n).split(',')[0].replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
/* A still water's own name must END in lake, lakes, reservoir, pond or ponds (or begin "Lake "),
   and must not hold a mountain word: "Thousand Lake Mountain" and "Tushar (Beaver) Mountain
   Lakes" are tagged lakes in the data but are a mountain and an area, not a water with a shore. */
const fStillBase = p => fPlaceBase(p).replace(/\s*(&|and)\s*state park$/, '').replace(/\s+no\.?\s*\d+$/, '');   // "Yuba Reservoir & State Park", "Blanding Reservoir No. 4"
const fStillPlace = p => !!p && p.lat != null && p.lon != null && (p.k === 'lake' || p.k === 'pond') &&
  (/\b(reservoirs?|lakes?|ponds?|res)$/.test(fStillBase(p)) || /^lake\s/.test(fStillBase(p))) && !/\b(mountains?|mtns?|peaks?|plateau|range)\b/.test(fStillBase(p));
/* Waters too big for one point to stand for: Lake Powell's point is not on the lake and misses 14
   of the 19 units its shore touches; Flaming Gorge's point is in Wyoming. Never used as a spot. */
const F_BIG_WATERS = ['lake powell', 'flaming gorge reservoir'];
/* A water named after one of these is a vague phrase ("a little reservoir", "the kids pond"),
   not the water of that name. */
const F_VAGUE_BEFORE = /^(a|an|the|some|any|this|that)$/;
const fWaterLabel = p => p.n + (p.c ? ', ' + p.c + ' Co.' : '');
const fWaterPlace = p => ({ kind: 'water', id: p.id, label: fWaterLabel(p), lat: p.lat, lon: p.lon });
/* The LAST water word in the name decides: "Deer Creek Reservoir" is a reservoir, "Provo River
   Delta" a river, "Lake Fork" a fork. A name with neither is not called a river. */
function fNamedMoving(name) {
  let last = null, m;
  for (const re of [F_STILL_WORD, F_MOVING_WORD]) { const g = new RegExp(re.source, 'g'); while ((m = g.exec(name))) if (!last || m.index > last.i) last = { i: m.index, moving: re === F_MOVING_WORD }; }
  return !!(last && last.moving);
}
/* What a water named in a sentence is, for the hunt finder. fWaterRead says what KIND of water
   it is and never looks at the words around it:
     { one: place } | { many: [places] } | { big: place } | { river: true } | { nopoint: true } |
     { plain: true } (a still water the name check keeps out, or a short still name: it blocks a
     unit name inside it but says nothing and makes no place) | null (not a water to the finder).
   Only a water NAMED IN FULL can become a place (wtr.short is a shorter way of saying it, "duck
   fork", "carbon county", "skyline drive": too close to ordinary words, towns and counties). A
   short name still counts as a water for the two things that cost nothing: a unit name inside it
   is not a unit, and a short name that is a river or creek gets the river line. The river line and
   the "no map point" line need the full name to END in a water word, so a hunting property
   ("Stewart Lake WMA") or a range ("Uinta Mountains") never gets one; "no map point" is only for
   a still water with no lake or pond place in the data at all. */
const F_MOVING_END = /\b(rivers?|creeks?|streams?|forks?|tributar(?:y|ies)|inlets?|inflows?|canals?|sloughs?)$/;
const F_STILL_END = /\b(reservoirs?|lakes?|ponds?|res)$/;
const fRefName = r => String((r.p ? (FPL[r.p] || {}).n : (FW[r.w] || FCOM[r.w] || {}).name) || '').split(',')[0].replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const F_AREA_WORD = /\b(mountains?|mtns?|peaks?|plateau|range)\b/;   // "Wasatch Mtn State Park Pond", "Monroe Mountain Lakes": an area, not a shore
function fWaterRead(wtr) {
  const r = fWaterKind(wtr);
  return r && r.plain && F_AREA_WORD.test(wtr.needle) ? null : r;   // an area name never blocks the unit named in it
}
function fWaterKind(wtr) {
  if (!wtr || typeof FPL === 'undefined' || typeof FBYW === 'undefined') return null;
  if (wtr.short) {
    const names = (wtr.refs || []).map(fRefName).filter(Boolean);
    if (!F_STILL_END.test(wtr.needle) && names.length && names.every(fNamedMoving)) return { river: true };
    return names.some(n => F_STILL_END.test(n)) ? { plain: true } : null;
  }
  if (fNamedMoving(wtr.needle)) return F_MOVING_END.test(wtr.needle) ? { river: true } : null;
  const pts = [], any = [], add = p => { if (!p) return; if (p.lat != null && p.lon != null && (p.k === 'lake' || p.k === 'pond') && any.indexOf(p) < 0) any.push(p); if (fStillPlace(p) && pts.indexOf(p) < 0) pts.push(p); };
  for (const r of wtr.refs || []) { if (r.p) add(FPL[r.p]); if (r.w) (FBYW[r.w] || []).forEach(add); }
  const big = pts.find(p => F_BIG_WATERS.indexOf(fPlaceBase(p)) >= 0);
  if (big) return { big };
  if (pts.length === 1) return { one: pts[0] };
  if (pts.length > 1) return { many: pts };
  if (!F_STILL_END.test(wtr.needle)) return null;
  return any.length ? { plain: true } : { nopoint: true };
}
/* What fWaterRead gives, less the cases a vague phrase turns off: a name directly after a, an,
   the, some, any, this or that is not turned into a place or a line (null), so "deer near a big
   lake" reads exactly as it always did. A river keeps its line: it resolves nothing. */
function fWaterSpot(wtr, text) {
  const r = fWaterRead(wtr);
  if (!r || r.river || r.plain) return r && r.river ? r : null;
  if (text != null) {
    const t = fWords(text), i = t.indexOf(' ' + wtr.needle + ' ');
    if (i >= 0 && F_VAGUE_BEFORE.test(t.slice(0, i).trim().split(' ').pop())) return null;
  }
  return r;
}
/* A species was found, no place was, and the sentence names a water: set q.place to its one
   point, or q.waterPick (which one?), or q.waterNote (why the question is still Where?). */
function fWaterApply(q) {
  q.waterNote = null; q.waterPick = null;
  if (q.place || !q.sp || !q.waterHit) return;
  const s = fWaterSpot(q.waterHit, q.text);
  if (!s) return;
  if (s.one) q.place = fWaterPlace(s.one);
  else if (s.many) q.waterPick = s.many;
  else if (s.big) { q.waterNote = 'big'; q.waterBig = fWaterLabel(s.big); }
  else if (s.river) q.waterNote = 'river';
  else if (s.nopoint) q.waterNote = 'nopoint';
}
/* Read the sentence. Anything not found becomes a question. */
function fParse(text) {
  /* Fishing is asked first. Utah's waters borrow the names of its game ("Sheep Creek
     Lake", "Quail Creek Reservoir", "Duck Fork"), so a sentence about fishing would
     otherwise be answered as a hunt. fishParse hands back nothing when the sentence
     is not about fishing. */
  /* Until the fishing rules arrive no water's name is known, so the "fish" in "deer
     near Fish Lake" cannot be told from a fishing word. While they are on their way,
     an animal to hunt with no fish and no fishing word means a hunt ("fishing at duck
     fork" is still fishing); the sentence is read again when they land. */
  if (typeof fishParse === 'function') {
    const fq_ = fishParse(text), w_ = fWords(text);
    if (fq_ && !(fq_.pending && !fq_.sp && typeof fGame === 'function' && fGame(w_) && !(typeof fFishWord === 'function' && fFishWord(w_)))) return { text, fish: fq_ };
  }
  const t = fWords(text);
  /* A water named in a sentence that is not about fishing. Its name must not be
     read as an animal ("Duck Fork Reservoir", "Moose Pond", "Sheep Creek Lake"), so
     it is taken out before the species is looked for, the same way Antelope Island
     is. It stays in for the place match below, where it belongs. */
  const wtr = typeof fishWaterIn === 'function' ? fishWaterIn(text, false) : null;
  /* A shorter way of saying a water ("duck fork", "deer creek") offers the fishing
     answer beside a hunt, and is taken out before the animal is looked for too, so
     "deer near duck fork" is deer, not duck. A two-word short name that runs across
     an animal's name is never matched (fSplitsGame), so "tushar mountain goat" keeps
     its mountain. */
  const wtr2 = wtr || (typeof fishWaterIn === 'function' ? fishWaterIn(text, 'two') : null);
  const q = { text, sp: null, bird: null, gap: null, wp: null, place: null, alsoUnit: null, pt: null, wantAntlerless: /\b(cow|antlerless|doe|meat|freezer)\b/.test(t), wantGeneral: /\b(general|over the counter|otc|no draw|guaranteed)\b/.test(t), wantLE: /\b(limited|draw|le |trophy|bonus)\b/.test(t) };
  const st = (wtr2 ? wtr2.rest : t).replace(F_PLACE_NOISE, ' ');   // species read from text with place names removed
  { const g = fGameIn(st); q.gap = g.gap; q.bird = g.bird; q.sp = g.sp; }
  for (const [k, re] of F_WEAPON) if (re.test(t)) { q.wp = k; break; }
  const m = /(\d{1,2})\s*(?:bonus|preference)?\s*(?:points?|pts)/.exec(t); if (m) q.pt = +m[1];
  let hitAlias = null;
  /* A town the hunter chose is found by "home" (the first one) or by a word the hunter gave it,
     never by its name: Provo, Price, Logan and Ogden sit inside the names of rivers. A word with
     no letters or digits in it (a stray "!") would match any sentence, so it is skipped. */
  for (const h of anchorsChosen()) {
    const a = h.aliases.find(x => fWords(x).trim() && t.includes(fWords(x)));
    if (a) { hitAlias = a; q.place = { kind: 'home', id: h.id, label: h.label, lat: h.lat, lon: h.lon }; break; }
  }
  /* A word the hunter picked for a town can also be the leading word of a real hunt unit (a
     hunter who calls a town "boulder" meets Boulder Elk and Boulder/Kaiparowits; "fishlake"
     meets Fishlake). The town wins, because the word is theirs for their own place - but
     silently swallowing a unit name would plan the wrong hunt, so the collision is surfaced and
     they can switch in one tap. Only aliases the hunter chose are tested this way, which keeps
     it from firing on common words. */
  if (hitAlias && UNITS) {
    const needle = fWords(hitAlias).trimEnd();                 // " boulder"
    const bases = [...new Set(UNITS.map(u => u.n.split(',')[0]))];
    const hits = bases.filter(b => fWords(b) === fWords(hitAlias) || fWords(b).startsWith(needle + ' '));
    if (hits.length) q.alsoUnit = hits.map(b => ({ label: b, units: UNITS.filter(u => u.n.split(',')[0] === b).map(u => u.n) }));
  }
  if (!q.place && /\b(here|where i am|my location|gps|right now)\b/.test(t)) q.place = { kind: 'gps' };
  if (!q.place && UNITS) {                                   // a unit named outright, longest match wins
    const all = fUnitNames();
    /* A unit name that lies inside the words of a water the fishing data knows - a still water
       or a river, by its full name or a short one ("joes valley reservoir", "diamond fork",
       "panguitch lake") - is the water, not the unit, whatever the water's point is under and
       whether or not the sentence has "the" in front of it. This holds for EVERY water the
       sentence names, not only the one the fishing rules keep: "elk diamond fork near strawberry
       reservoir" names two waters, and "diamond" is a piece of the first, so it is not Diamond Mtn.
       A unit named OUTSIDE all those words wins as before. The water is then handled by the water
       rules (fWaterApply below), which answer for the one water kept. */
    const spans = [];
    for (const w of (typeof fishWatersIn === 'function' ? fishWatersIn(text) : [])) {
      if (!fWaterRead(w)) continue;                            // an area name ("wasatch mountain") never blocks a unit
      const i = t.indexOf(' ' + w.needle + ' ');
      if (i >= 0) spans.push({ a0: i + 1, a1: i + 1 + w.needle.length, short: !!w.short, needle: w.needle });
    }
    /* Compare spans. A unit match that lies inside a water's words, or is exactly them, is the
       water. One that is longer and contains them ("Panguitch Lake/Zion" around "panguitch lake",
       "San Juan Bull Elk", "Utah Lake Extended Archery Area") is a unit named outright. So is a
       short name that is exactly a unit's name ("pine valley", "east canyon", "san juan", "nine
       mile"): the short name is only an alias of a water. So is a match that is the whole water
       name when the word "unit" or "units" comes straight after it ("the panguitch lake unit"),
       with or without an article. A needle that is only a FRAGMENT of a water's name ("diamond" in
       "diamond fork unit", "valley" in "joes valley unit") is still the water: the water rules
       answer as they do without the word "unit". */
    const unitWord = sp => /^(units?)( |$)/.test(t.slice(sp.a1 + 1).trimStart());
    const clear = needle => {
      if (spans.some(sp => sp.short && needle.trim() === sp.needle)) return true;
      let p = t.indexOf(needle);
      while (p >= 0) {
        const s0 = p + 1, e0 = p + needle.length - 1;
        if (!spans.some(sp => s0 >= sp.a0 && e0 <= sp.a1 && !(unitWord(sp) && s0 === sp.a0 && e0 === sp.a1))) return true;
        p = t.indexOf(needle, p + 1);
      }
      return false;
    };
    const hit = all.find(([needle]) => clear(needle));
    if (hit) q.place = { kind: 'unit', label: hit[1], units: UNITS.filter(u => u.n.split(',')[0] === hit[1]).map(u => u.n) };
  }
  /* Nothing to hunt was named and a water was. If it is not also the name of a hunt
     unit, the sentence is about that water, and fishing can answer it. If it is both
     ("Panguitch Lake"), the hunt finder keeps it and offers the water in one tap. */
  if (wtr && !q.sp && !q.bird && !q.gap && !q.wp && !(q.place && q.place.kind === 'unit') && !(typeof F_HUNT_WORD !== 'undefined' && F_HUNT_WORD.test(wtr.rest))) return { text, fish: fishParse(text, true) };
  if (wtr2) { q.alsoWater = wtr2.needle; q.waterHit = wtr2; }
  /* Big game and a water, and nothing else gave a place (a home word, GPS words and a unit
     named outright all came first and still win). */
  fWaterApply(q);
  return q;
}
const fBase = n => (n || '').split(',')[0].replace(/\s*\(.*\)\s*/, '').trim().toLowerCase();
/* Exact unit match, or a whole-unit hunt when I am in one of its sub-units. A
   sub-unit hunt when I am only known to be in the parent is a maybe. */
const fUnitMatch = (huntUnit, myUnits) => {
  const hu = huntUnit.toLowerCase(), hb = fBase(huntUnit), huSub = hu.includes(',');
  for (const u of myUnits) {
    const ul = u.toLowerCase(), ub = fBase(u);
    if (ul === hu) return 'yes';
    if (!huSub && ub === hb) return 'yes';                       // hunt is the whole unit, I am in a part of it
  }
  return myUnits.some(u => fBase(u) === hb) ? 'maybe' : '';
};
const fSeason = id => (DB.seasons.seasons || []).find(s => s.id === id);
const fDates = id => { const s = fSeason(id); return s ? `${fmt(d0(s.start))} to ${fmt(d0(s.end))}` : ''; };
function fOddsLine(h) {                                       // last year's result at the user's points, if they set them
  if (!ODDS) return '';
  const grp = h.g, key = grp + '|' + h.s, typed = fq.parsed && fq.parsed.pt;
  const pts = typed != null ? typed : (draw.pts[key] != null ? draw.pts[key] : null);
  if (pts == null) return '<span class="s">Set your points to see last year\'s odds.</span>';
  const o = oddsAt(h, pts); return `<span class="s">${pts} pt${pts === 1 ? '' : 's'} last year: <b>${esc(o.txt)}</b>${o.pct != null ? ' (' + o.pct + '%)' : ''}</span>`;
}
function fResults(q, myUnits) {
  const out = [], H = HU.hunts, yr = ODDS ? Object.keys(ODDS.years).sort().pop() : null, hunts = yr ? Object.entries(ODDS.years[yr]) : [];
  const inList = k => (H[k] || []).map(r => Object.assign({}, r, { m: fUnitMatch(r.unit, myUnits) })).filter(r => r.m);
  const sub = r => r.m === 'maybe' ? ' <i>(a part of this unit - check the boundary on the map)</i>' : '';
  const wpOk = name => !q.wp || (q.wp === 'archery' ? /archery/i : q.wp === 'muzzleloader' ? /muzz/i : /any legal|rifle|alw/i).test(name);
  const card = (title, rows) => rows.length && out.push({ title, rows });
  if (!q.sp || q.sp === 'elk') {
    const ab = inList('elk_anybull'), sp = inList('elk_spike'), rows = [];
    for (const u of ab) {
      if (wpOk('archery')) rows.push({ t: `Any-bull elk, general archery - ${u.unit}`, sub: sub(u), s: `${fDates('elk-archery-anybull')}. Over the counter. Any bull or antlerless.` });
      if (wpOk('rifle')) rows.push({ t: `Any-bull elk, general rifle - ${u.unit}`, sub: sub(u), s: `Early ${fDates('elk-early-rifle')} or late ${fDates('elk-late-rifle')}. Over the counter; pick one.` });
      if (wpOk('muzzleloader')) rows.push({ t: `Any-bull elk, general muzzleloader - ${u.unit}`, sub: sub(u), s: `${fDates('elk-muzz')}. Over the counter.` });
    }
    for (const u of sp) {
      if (wpOk('archery')) rows.push({ t: `Spike elk, general archery - ${u.unit}`, sub: sub(u), s: `${fDates('elk-archery-spike')}. Over the counter. Spike or antlerless only.` });
      if (wpOk('rifle')) rows.push({ t: `Spike elk, general rifle - ${u.unit}`, sub: sub(u), s: `${fDates('elk-spike-rifle')}. Over the counter. Spike only - a branched bull here is a citation.` });
      if (wpOk('muzzleloader')) rows.push({ t: `Spike elk, general muzzleloader - ${u.unit}`, sub: sub(u), s: `${fDates('elk-muzz')}. Over the counter.` });
    }
    if (!q.wantLE || q.wantGeneral) card('Elk you can buy over the counter', rows);
    const ctl = inList('antlerless_elk_control'); if (ctl.length && (q.wantAntlerless || !q.wantLE)) card('Antlerless elk control permits here', ctl.map(u => ({ t: `Antlerless elk control - ${u.unit}`, s: 'Sold separately; check dates and quota at wildlife.utah.gov/biggame.', sub: sub(u) })));
  }
  if (!q.sp || q.sp === 'deer') {
    const g = inList('deer_gen'), rows = [];
    for (const u of g) {
      const ex = /extended/i.test(u.unit);
      if (wpOk('archery')) rows.push({ t: `General buck deer, archery - ${u.unit}`, sub: sub(u), s: `${fDates('deer-archery')}. Drawn with preference points (most units draw at 0-1 point). Extended archery ${fDates('deer-ext-archery')} on the Wasatch Front and others.` });
      if (wpOk('muzzleloader')) rows.push({ t: `General buck deer, muzzleloader - ${u.unit}`, sub: sub(u), s: `${fDates('deer-muzz')}. Drawn with preference points.` });
      if (wpOk('rifle')) rows.push({ t: `General buck deer, rifle - ${u.unit}`, sub: sub(u), s: `Early ${fDates('deer-early-rifle')} or ${fDates('deer-rifle')}. Drawn with preference points.` });
    }
    if (!q.wantLE || q.wantGeneral) card('Deer - general season (draw, preference points)', rows);
  }
  // Draw hunts from last year's results, matched by unit name in the hunt title
  const spMap = { elk: ['EB', 'EA'], deer: ['DB', 'DA'], pronghorn: ['PB', 'PD', 'PA'], moose: ['MB', 'MA'], sheep: ['DS', 'RS', 'RE', 'DE'], 'mountain goat': ['GO'], bison: ['BI'] };
  const want = q.sp ? spMap[q.sp] : null;
  const drawRows = hunts.filter(([c, h]) => (!want || want.includes(c.slice(0, 2))) && wpOk(h.n) && (!q.wantAntlerless || h.g === 'Antlerless') && (!q.wantGeneral || h.g !== 'Limited entry and once-in-a-lifetime'))
    .map(([c, h]) => { const segs = h.n.split(' - '); const unit = h.g === 'General-season buck deer' ? segs[0] : (segs[1] || ''); return [c, h, fUnitMatch(unit, myUnits)]; }).filter(x => x[2])
    .map(([c, h, m]) => ({ t: h.n + (m === 'maybe' ? ' (part of the unit - check the boundary)' : ''), s: `${esc(c)} &middot; ${h.g}${h.k === 'p' ? ' &middot; preference points' : ' &middot; bonus points'}. ${fOddsLine(h)}`, code: c }));
  if (!q.wantGeneral) card(`Draw hunts here (${yr || 'last year'} results)`, drawRows.slice(0, 40));
  return out;
}
/* Unit names carry their own commas ("Wasatch Mtns, East"), so joining a list of
   them with a comma reads as one long run. */
const fList = a => a.map(esc).join('; ');
/* ---------------------------------------------------------------- birds --- */
/* Upland and waterfowl do not work like big game: there is no hunt unit you are
   standing in. The seasons are statewide or by zone, and the question that
   actually matters is which marsh or foothill is closest. So this path answers
   "when" from the season list the app already carries and "where" from the 88
   access points, which already hold a drive time from each anchor town.

   [key, label, what it sounds like in a sentence, season ids, access-point species] */
const F_BIRDS = [
  // narrow first: "sage grouse" contains "grouse", "jackrabbit" contains "rabbit"
  ['sage-grouse', 'Greater sage-grouse', /\bsage[\s-]?grouse\b/, ['sage-grouse'], null, 'A drawn hunt in four named areas - Diamond and Blue Mountain, Parker Mtn, Rich County and West Box Elder. Boundary maps are at hunt.utah.gov.'],
  ['sharptail', 'Sharp-tailed grouse', /\bsharp[\s-]?tail(ed)?s?\b/, ['sharptail-grouse'], null, 'A drawn hunt in Northeast Box Elder and Cache counties, on all or largely private property. Get written permission before you even apply.'],
  ['ptarmigan', 'White-tailed ptarmigan', /\bptarmigans?\b/, ['ptarmigan'], /ptarmigan/i, null],
  ['pheasant', 'Pheasant', /\b(pheasants?|roosters?|ring-?necks?|ring-?necked)\b/, ['pheasant', 'pheasant-youth'], /pheasant/i, null],
  ['chukar', 'Chukar and gray partridge', /\b(chukars?|partridges?|huns?)\b/, ['chukar', 'chukar-youth'], /chukar/i, null],
  ['quail', 'Quail', /\b(quail|gambels?)\b/, ['quail'], /quail|upland/i, null],
  ['grouse', 'Dusky and ruffed grouse', /\b(grouse|dusky|ruffed)\b/, ['dusky-ruffed'], /grouse|upland/i, 'Forest grouse are statewide in the timber. The app’s access points are marsh and upland bird properties, so use the Map tab’s land ownership layer to find public timber.'],
  ['jackrabbit', 'Jackrabbit', /\bjack\s?rabbits?\b/, ['jackrabbit'], null, 'Statewide, year round, and you do not need a licence. Use the Map tab’s land ownership layer to find public ground.'],
  ['cottontail', 'Cottontail rabbit', /\b(cottontails?|rabbits?|bunn(y|ies))\b/, ['cottontail'], null, 'Statewide on public land. Use the Map tab’s land ownership layer - the 88 access points are bird properties, not rabbit ground.'],
  ['hare', 'Snowshoe hare', /\b(snowshoes?|hares?)\b/, ['snowshoe-hare'], null, 'High country timber, statewide. Use the Map tab’s land ownership layer to find public ground.'],
  ['pigeon', 'Band-tailed pigeon', /\b(band[\s-]?tail(ed)?\s*pigeons?|band[\s-]?tails?|pigeons?)\b/, ['band-tailed-pigeon'], null, 'Statewide, but a two-week season in early September. Needs a free permit.'],
  ['dove', 'Mourning and white-winged dove', /\b(doves?|mourning dove|white-?winged|collared-?doves?)\b/, ['dove'], null, 'Statewide. Doves sit on ag edges, water and gravel roads in the morning; the app’s access points are marsh and upland bird properties rather than dove ground.'],
  ['crow', 'American crow', /\bcrows?\b/, ['crow', 'crow2'], null, 'Statewide, in two split seasons. Every national wildlife refuge in Utah is closed to crow hunting.'],
  ['crane', 'Sandhill crane', /\b(sandhills?|cranes?)\b/, ['crane-cache-rich', 'crane-boxelder', 'crane-uintah-early', 'crane-uintah-mid', 'crane-uintah-late'], null, 'A drawn hunt in Cache, Rich and East Box Elder counties and the Uintah Basin Zone. One bird for the whole season.'],
  ['duck', 'Duck, coot and snipe', /\b(ducks?|mallards?|teal|wid?geons?|gadwalls?|pintails?|canvasbacks?|mergansers?|coots?|snipe|redheads?|bluebills?|scaup)\b/, { north: ['duck-n', 'scaup-n'], south: ['duck-s', 'scaup-s'] }, /duck/i, null],
  ['lightgoose', "Light geese (snow, blue and Ross's)", /\b(snow\s*(goose|geese)|blue\s*(goose|geese)|ross'?s?\s*(goose|geese)|light\s*(goose|geese))\b/, ['light-geese-n', 'light-geese-n2', 'light-geese-s', 'light-geese-s2'], /duck/i, null],
  ['goose', 'Geese', /\b(goose|geese|honkers?|specklebell(y|ies)|white-?fronted)\b/, ['geese-wf', 'geese-wf2', 'geese-ebe', 'geese-n', 'geese-n2', 'geese-s', 'light-geese-n', 'light-geese-n2', 'light-geese-s', 'light-geese-s2'], /duck/i, null],
  ['swan', 'Tundra swan', /\bswans?\b/, ['swan'], /duck/i, null],
  ['turkey', 'Wild turkey', /\b(turkeys?|gobblers?)\b/, ['turkey-fall', 'turkey-general', 'turkey-le'], /turkey/i, null]
];
/* Recognised by name, but the app has no season data for them yet. Saying so
   beats a confident wrong answer. Tested BEFORE the list above, because
   "sage grouse" contains "grouse" and "sandhill crane" is not a duck. */
const F_BIRD_GAPS = [
  ['Rails', /\brails?\b/, 'a species with no open season in Utah at all']
];
/* Utah splits waterfowl by county, and the guidebook lists which county is in
   which zone, so the zone is read off the county rather than guessed. Tooele is
   split down I-80 and deliberately comes back unknown. Goose areas are drawn on
   maps instead of county lines, so geese show every area by name rather than
   the app picking one for you. Transcribed 2026-09-22 from the 2026-27
   guidebook, pages 10 and 64-66. */
const F_NORTH_CO = ['box elder', 'cache', 'daggett', 'davis', 'duchesne', 'morgan', 'rich', 'salt lake', 'summit', 'uintah', 'utah', 'wasatch', 'weber'];
const F_SOUTH_CO = ['beaver', 'carbon', 'emery', 'garfield', 'grand', 'iron', 'juab', 'kane', 'millard', 'piute', 'san juan', 'sanpete', 'sevier', 'washington', 'wayne'];
function fCountyZone(c) {
  c = String(c || '').toLowerCase().replace(/\s+co\.?$/, '').trim();
  if (F_NORTH_CO.indexOf(c) >= 0) return 'north';
  if (F_SOUTH_CO.indexOf(c) >= 0) return 'south';
  return null;                                  // Tooele, or somewhere we cannot place
}

const F_BIRD_CHIP = { pheasant: 'Pheasant', chukar: 'Chukar', quail: 'Quail', grouse: 'Grouse', 'sage-grouse': 'Sage grouse', sharptail: 'Sharp-tailed', ptarmigan: 'Ptarmigan', duck: 'Duck', goose: 'Geese', lightgoose: 'Light geese', swan: 'Swan', crane: 'Crane', dove: 'Dove', pigeon: 'Pigeon', crow: 'Crow', turkey: 'Turkey', cottontail: 'Cottontail', hare: 'Snowshoe hare', jackrabbit: 'Jackrabbit' };
const fBird = k => F_BIRDS.find(b => b[0] === k);
const fPointZone = p => fCountyZone(String(p.county || '').split(',')[0]);   // some points span two counties
/* Where today sits in the season. */
function fOpen(s) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const a = d0(s.start), b = d0(s.end);
  if (now < a) { const n = Math.round((a - now) / 86400000); return ['soon', n === 1 ? 'Opens tomorrow' : 'Opens in ' + n + ' days']; }
  if (now > b) return ['done', 'Closed for the year'];
  const n = Math.round((b - now) / 86400000);
  return ['open', n <= 14 ? 'Open now, ' + n + ' days left' : 'Open now'];
}
/* One access point, keeping the drive time relative to the place that was asked
   about rather than the town chosen at the top of the screen. */
const fHomeId = place => place ? (place.kind === 'home' ? place.id : null) : anchorId();   // no place named: use the header town
function fBirdRow(p, place, homeZone) {
  const hid = fHomeId(place), d = hid && (p.drive || {})[hid];
  const pz = homeZone ? fPointZone(p) : null;
  const flag = pz && pz !== homeZone ? ` &middot; <b>${pz === 'north' ? 'Northern' : 'Southern'} Zone dates</b>` : '';
  const v = d ? (d.range ? d.range[0] + '-' + d.range[1] : String(d.min)) : (place && place.lat != null ? miles(place.lat, place.lon, p.lat, p.lon).toFixed(0) : '--');
  const sub = d ? (d.range ? 'min *' : 'min') : (place && place.lat != null ? 'mi' : '');
  return `<button class="row" data-pt="${esc(p.id)}" style="--g:var(--bird)"><span class="pill"></span>
    <span><span class="t">${esc(p.name)}</span><span class="s">${esc(p.county)} Co. &middot; ${esc(p.species)}${p.confidence === 'Low' ? ' &middot; verify ownership first' : ''}${flag}</span></span>
    <span class="v">${esc(v)}<small>${sub}</small></span></button>`;
}
function fBirdPlaces(bird, place) {
  const pts = bird[4] ? (DB.birds || []).filter(p => bird[4].test(p.species || '')) : [];   // rabbits and doves have no marsh to point at
  const hid = fHomeId(place);
  const key = p => {
    const d = hid && (p.drive || {})[hid];
    if (d) return d.range ? d.range[0] : d.min;
    /* Points with no routed time sort on straight-line miles put onto a
       minutes-like scale at roughly 43 mph. Without this the list would compare
       a 92-mile drive against a 64-minute one and order them wrongly. */
    if (place && place.lat != null) return miles(place.lat, place.lon, p.lat, p.lon) * 1.4;
    const h = anchorById(hid);
    return h ? miles(h.lat, h.lon, p.lat, p.lon) * 1.4 : 1e9;
  };
  return pts.sort((a, b) => key(a) - key(b));
}
function fBirdView(q) {
  const bird = q.bird, place = q.place, hid = fHomeId(place);
  const hrec = hid && anchorById(hid);
  const zone = hrec ? fCountyZone(hrec.county) : null;
  const zoned = !Array.isArray(bird[3]);                 // ducks: the answer depends on the zone
  const pts = fBirdPlaces(bird, place);
  let h = `<div class="sec-title">${esc(bird[1])}${place ? ' &middot; ' + esc(place.label || 'here') : ''}</div>`;

  {
    /* The zone that governs is the one you are STANDING in, not the one you
       drove from. Torrey is in the Southern Zone, but every waterfowl access
       point the app carries is a northern marsh - quoting southern dates over a
       list of northern places would be a trap. So the seasons shown cover the
       starting town's zone and every zone the listed places are actually in. */
    const zs = [];
    if (zone) zs.push(zone);
    pts.slice(0, 25).forEach(x => { const z = fPointZone(x); if (z && zs.indexOf(z) < 0) zs.push(z); });
    if (!zs.length) { zs.push('north', 'south'); }
    const ids = !zoned ? bird[3] : zs.reduce((a, z) => a.concat(bird[3][z] || []), []);
    if (zoned && !zone) h += `<div class="warnbox" style="margin-top:4px"><b>Both zones are shown.</b> Utah splits
      waterfowl into a Northern and a Southern Zone on county lines, and the app cannot tell which one
      ${esc((place && place.label) || 'that spot')} is in (Tooele County is split down I-80).
      Read the zone off the area on each season below.</div>`;
    else if (zoned && zs.length > 1) h += `<div class="warnbox" style="margin-top:4px"><b>Some of these places are across a zone line.</b>
      ${esc(hrec.label)} is in the ${esc(zone === 'north' ? 'Northern' : 'Southern')} Zone, and some places below are in the other one - those are marked.
      <b>The season that counts is the zone you hunt in, not the one you live in</b>, so read the marker on the place before the dates above.</div>`;
    const seasons = ids.map(fSeason).filter(Boolean);
    h += `<div class="card">` + seasons.map(s => {
      const o = fOpen(s);
      return `<div class="row" style="--g:${o[0] === 'open' ? 'var(--brand)' : o[0] === 'soon' ? 'var(--accent)' : 'var(--faint)'}"><span class="pill"></span>
        <span><span class="t">${esc(s.name)}</span><span class="s">${esc(fmt(d0(s.start)))} to ${esc(fmt(d0(s.end)))}${s.bag && s.bag !== '-' ? ' &middot; ' + esc(s.bag) : ''}<br>${esc(s.area)} &middot; ${esc(s.permit)}${s.note ? '<br>' + esc(s.note) : ''}</span></span>
        <span class="v" style="font-size:12px">${esc(o[1])}</span></div>`;
    }).join('') + `</div>`;
    if (zoned && zone && zs.length === 1) h += `<p class="fine" style="padding-left:2px">These are <b>${esc(seasons[0] ? seasons[0].area : '')}</b> dates, because ${esc(hrec.label)} is in ${esc(hrec.county)} County. Confirm the zone in the guidebook before opening morning.</p>`;
    if (bird[0] === 'goose') h += `<p class="fine" style="padding-left:2px">Goose areas are drawn on maps, not county lines, so all four are listed. Check which one you are in at hunt.utah.gov before opening morning.</p>`;
  }

  h += `<div class="sec-title">Where to go${pts.length ? ' &middot; ' + pts.length + ' place' + (pts.length === 1 ? '' : 's') : ''}${hrec ? ' &middot; by drive from ' + esc(hrec.label) : ''}</div>`;
  if (!pts.length) {
    h += bird[5] ? `<p class="fine" style="padding-left:2px">${esc(bird[5])}</p>`
      : `<p class="empty">No access points in the app are tagged for ${esc(bird[1].toLowerCase())}. The Access tab has all 88.</p>`;
  } else {
    h += `<div class="card">` + pts.slice(0, 25).map(p => fBirdRow(p, place, zoned ? zone : null)).join('') + `</div>`;
    if (pts.length > 25) h += `<p class="fine">Showing the 25 closest of ${pts.length}. The Access tab has the rest.</p>`;
    /* The access list is concentrated on the northern marshes and foothills. If
       the closest one is half a day away, say so rather than letting a list of
       places imply there is something nearby. */
    const near = hid && (pts[0].drive || {})[hid];
    const mins = near ? (near.range ? near.range[0] : near.min) : null;
    if (mins != null && mins > 120) h += `<p class="fine" style="padding-left:2px">Every one of these is a long way off - the closest is about ${Math.round(mins / 60)} hours. The app's access list is concentrated on the northern marshes and foothills, so it is thin wherever you are hunting from.</p>`;
    if (bird[0] === 'goose' || bird[0] === 'swan') h += `<p class="fine" style="padding-left:2px">These are the waterfowl marshes; the app tags them by duck, and they hold ${esc(bird[0] === 'swan' ? 'swan' : 'geese')} too.</p>`;
  }
  h += `<p class="fine" style="padding-left:2px">Season dates and limits are from the 2026 guidebooks; places and drive times from the app's access list. Migratory birds need HIP registration, and ducks, geese, swan and coot need a federal duck stamp if you are 16 or over. Nontoxic shot is required for waterfowl and on most WMAs. Not legal advice - the guidebook is the authority.</p>`;
  return h;
}
const fGapNotice = g => `<div class="warnbox" style="margin-top:12px"><b>${esc(g[0])} is not in the app yet.</b>
  In Utah it is ${esc(g[2])}, so the dates are not something to guess at. Look it up at
  wildlife.utah.gov before you plan around it.</div>
  <p class="fine" style="padding-left:2px">The app carries every other species on the hunting and combination licence:
  upland birds, small game, doves, crow, sandhill crane, the drawn grouse, waterfowl in both zones and turkey.</p>`;

function vFind() {
  fLoad();
  const q = fq.parsed || null;
  if (q && !q.fish && q.place && q.place.kind === 'gps' && q.place.lat == null) fGpsEnsure();   // never left waiting with nothing pending
  let h = `<form id="findform" style="margin-top:12px"><input class="search" id="findq" placeholder="pheasant near home, elk where I am, or trout near home" value="${esc(fq.text)}"><div class="acts" style="padding:8px 0 0"><button class="btn" type="submit">Find hunts</button></div></form>
    <p class="fine" style="padding-left:2px">Try: "elk near home", "pheasant near home", "chukar where I am", "archery deer Book Cliffs", "limited entry elk Wasatch, 7 points", "trout near home", "Strawberry Reservoir rules". Works with no signal.</p>`;
  if (!q) return h;
  if (q.fish) return h + (FR ? fStale(fNow(), null, false) : '') + fishAnswer(q.fish) + (FR ? F_FOOT() : '');    // fishing answers from the guidebook rules and UDWR's places
  if (q.gap) return h + fGapNotice(q.gap);                 // named it, but there is no data to stand behind
  if (q.bird) return h + (q.gpsErr ? `<div class="warnbox" style="margin-top:4px">${esc(q.gpsErr)}</div>` : '') + fBirdView(q);                     // birds answer from seasons + access, not hunt units
  if (!HU || !UNITS) return h + '<p class="empty">Loading the hunt lists&hellip;</p>';
  // Questions first
  const water = q.alsoWater ? `<div class="warnbox" style="margin-top:4px"><b>That sentence also names a water.</b> This answer is about hunting. For the fishing rules:</div>
    <div class="chipsrow"><button class="chip" data-fask="usewater" data-fval="${esc(q.alsoWater)}">Fishing at ${esc(q.alsoWater)}</button></div>` : '';
  if (!q.sp) return h + water + fAsk('What do you want to hunt?', Object.entries(F_LABEL).concat(F_BIRDS.map(b => ['bird:' + b[0], F_BIRD_CHIP[b[0]]])), 'sp');
  /* The same Where? question every time, with a line above it when the sentence named a water
     that could not be turned into a place. */
  const ask = note => (q.gpsErr ? `<div class="warnbox" style="margin-top:4px">${esc(q.gpsErr)}</div>` : '') + (note ? `<div class="warnbox" style="margin-top:4px">${esc(note)}</div>` : '') + fAsk('Where?', anchorsChosen().map(x => [x.id, x.label]).concat([['gps', 'Where I am now']]), 'place') + '<p class="fine" style="padding-left:2px">Or name a unit in the sentence, like "Wasatch Mtns" or "Book Cliffs".</p>';
  if (!q.place && q.waterPick) return h + fAsk('Which one?', q.waterPick.map(p => [p.id, fWaterLabel(p)]), 'wplace') + '<p class="fine" style="padding-left:2px">More than one water has that name. Or name a unit in the sentence, like "Wasatch Mtns" or "Book Cliffs".</p>';
  if (!q.place) return h + ask(q.waterNote === 'river' ? F_RIVER_LINE : q.waterNote === 'nopoint' ? F_NOPOINT_LINE : q.waterNote === 'big' ? q.waterBig + ' touches many hunt units. Pick a place, name a unit, or use Where I am now.' : '');
  if (q.place.kind === 'gps' && !q.place.lat) return h + `<p class="empty">Getting a GPS fix&hellip;</p>`;
  const myUnits = q.place.units || (q.place.lat ? unitsAt(q.place.lon, q.place.lat).map(u => u.n) : []);
  const isWater = q.place.kind === 'water';
  if (!myUnits.length) return h + `<p class="empty">No hunt boundary found under ${esc(q.place.label || 'that spot')}. Try naming a unit.</p>`;
  const res = fResults(q, myUnits);
  if (isWater) h += `<div class="warnbox" style="margin-top:4px">Units at one point on ${esc(q.place.label)}${/\.$/.test(q.place.label) ? '' : '.'} A lake can touch more than one hunt unit. Check the unit boundary map before you hunt.</div>`;
  h += `<div class="sec-title">${esc(F_LABEL[q.sp])}${q.wp ? ' &middot; ' + esc(q.wp) : ''} &middot; ${esc(q.place.label || 'here')}</div>
    <p class="fine" style="padding-left:2px">Hunt boundaries under that spot: <b>${fList(myUnits)}</b>. One place can sit in several overlapping hunts, so check the boundary on the map before you buy.</p>`;
  /* Only offer the switch for units that would actually answer. The boundary layer and the
     hunt lists do not always spell a unit the same way, so some candidates return nothing -
     a chip that leads to an empty page is worse than no chip. */
  const useful = (q.alsoUnit || []).filter(u => { try { return fResults(q, u.units).length > 0; } catch (e) { return false; } });
  if (useful.length) h += `<div class="warnbox" style="margin-top:4px"><b>That is also the name of a hunt unit.</b>
    This answer is for ${esc(q.place.label)}, because that is your own word for it. If you meant the unit, switch:</div>
    <div class="chipsrow">${useful.map(u => `<button class="chip" data-fask="useunit" data-fval="${esc(u.label)}">${esc(u.label)}</button>`).join('')}</div>`;
  if (!q.wp) h += fAsk('Which weapon? (or leave it open)', [['archery', 'Archery'], ['muzzleloader', 'Muzzleloader'], ['rifle', 'Rifle / any legal weapon'], ['any', 'Show all']], 'wp');
  for (const c of res) h += `<div class="sec-title">${esc(c.title)}</div><div class="card">${c.rows.map(r => `<${r.code ? 'button' : 'div'} class="row" ${r.code ? `data-draw="${esc(r.code)}"` : ''} style="--g:var(--brand)"><span class="pill"></span><span><span class="t">${esc(r.t)}${r.sub || ''}</span><span class="s">${r.s}</span></span><span class="v"></span></${r.code ? 'button' : 'div'}>`).join('')}</div>`;
  if (!res.length) h += `<p class="empty">Nothing matched in ${fList(myUnits)} for ${esc(F_LABEL[q.sp])}${q.wp ? ' with ' + q.wp : ''}. Try another weapon or drop the extra words.</p>`;
  h += `<p class="fine" style="padding-left:2px">General dates from the 2026 guidebook; unit lists from UDWR's 2026 hunt boundaries; draw odds from UDWR's published results. Over-the-counter permits still have sale dates and, for some hunts, caps. Confirm at wildlife.utah.gov before you buy.</p>`;
  return h;
}
const F_RIVER_LINE = 'A river runs through many hunt units. Pick a place, name a unit, or use Where I am now.';
const F_NOPOINT_LINE = 'Ranger Hawk has no map point for that water. Pick a place, name a unit, or use Where I am now.';
const fAsk = (question, opts, key) => `<div class="sec-title">${esc(question)}</div><div class="chipsrow">${opts.map(([v, l]) => `<button class="chip" data-fask="${key}" data-fval="${esc(v)}">${esc(l)}</button>`).join('')}</div>`;
/* Ask the phone where it is, the way the Today screen's "Where am I" does, and answer from it.
   The request belongs to the SENTENCE, not to one parse of it: when the fishing rules land and
   the sentence is read again (fishing.js), the new parse is waiting for the same fix, and gets
   it from here. A refusal, a timeout or no location service is said in words, never a silent
   nothing, and the screen is never left on "Getting a GPS fix" with nothing pending. */
let fGpsReq = null;                                        // { text, state: 'pending' | 'fix' | 'err', lat, lon, msg }
function fGpsStart(text) {
  const r = fGpsReq = { text, state: 'pending' };
  if (!navigator.geolocation) { r.state = 'err'; r.msg = 'This phone is not sharing location with the app.'; return r; }
  navigator.geolocation.getCurrentPosition(pos => {
    if (fGpsReq !== r) return;
    r.state = 'fix'; r.lat = pos.coords.latitude; r.lon = pos.coords.longitude; fGpsApply(); render();
  }, err => {
    if (fGpsReq !== r) return;
    r.state = 'err';
    r.msg = err && err.code === 1 ? 'No GPS fix: ' + (err.message || 'location was refused') + '. Allow location for this app in the phone settings and try again.' : 'No GPS fix yet. Try again in the open.';
    fGpsApply(); render();
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  return r;
}
/* Put the recorded result on the current answer if it is still waiting for a fix and is the same sentence. */
function fGpsApply() {
  const q = fq.parsed, r = fGpsReq;
  if (!q || q.fish || !q.place || q.place.kind !== 'gps' || q.place.lat != null || !r || r.text !== fq.text) return;
  if (r.state === 'fix') { q.place = { kind: 'gps', label: 'where I am', lat: r.lat, lon: r.lon }; q.gpsErr = null; }
  else if (r.state === 'err') { q.place = null; q.gpsErr = r.msg; }
}
/* An answer that is waiting for a fix: use the recorded result, or start a request if none is on its way. */
function fGpsEnsure() {
  if (!fGpsReq || fGpsReq.text !== fq.text) fGpsStart(fq.text);
  fGpsApply();
}
function fGps(q) {                                         // the chip, or a sentence that says "where I am"
  q.gpsErr = null; q.place = { kind: 'gps' };
  fGpsStart(fq.text); fGpsApply();
}
function fRun(text) {
  fq.text = text; fq.touched = false; fq.parsed = fParse(text);
  if (fq.parsed.fish) {
    const q = fq.parsed.fish;
    if (q.place && q.place.kind === 'gps' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(p => { q.place = { kind: 'gps', label: 'where I am', lat: p.coords.latitude, lon: p.coords.longitude }; render(); },
        () => { q.place = null; render(); }, { enableHighAccuracy: true, timeout: 15000 });
    }
    render(); return;
  }
  if (fq.parsed.place && fq.parsed.place.kind === 'gps') fGps(fq.parsed);
  render();
}
document.addEventListener('submit', e => { if (e.target.id === 'findform') { e.preventDefault(); fRun($('findq').value.trim()); } });
document.addEventListener('click', e => {
  const t = e.target.closest('[data-fask]'); if (!t) return;
  fq.touched = true;                                       // answers given by tapping are not thrown away by a later re-read
  const q = (fq.parsed && !fq.parsed.fish) ? fq.parsed : fParse(''); const v = t.dataset.fval;
  if (t.dataset.fask === 'sp') { if (v.indexOf('bird:') === 0) { q.bird = fBird(v.slice(5)); q.sp = null; } else { q.sp = v; q.bird = null; } }
  if (t.dataset.fask === 'sp' && q.sp) fWaterApply(q);     // "hunt near fish lake", then the animal: the water becomes the place now
  if (t.dataset.fask === 'wplace') { const p = (q.waterPick || []).find(x => x.id === v); if (p) { q.place = fWaterPlace(p); q.waterPick = null; } }
  if (t.dataset.fask === 'usewater') { fq.parsed = { text: fq.text, fish: fishParse(v, true) }; render(); return; }
  if (t.dataset.fask === 'useunit') { q.place = { kind: 'unit', label: v, units: (UNITS || []).filter(u => u.n.split(',')[0] === v).map(u => u.n) }; q.alsoUnit = null; }
  if (t.dataset.fask === 'wp') q.wp = v === 'any' ? null : v, q.wpAsked = true;
  if (t.dataset.fask === 'place') { const h = anchorsChosen().find(x => x.id === v); q.place = h ? { kind: 'home', id: h.id, label: h.label, lat: h.lat, lon: h.lon } : { kind: 'gps' }; if (!h) { fq.parsed = q; fGps(q); render(); return; } else q.gpsErr = null; }
  fq.parsed = q; render();
});
