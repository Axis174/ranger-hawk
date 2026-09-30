/* Ranger Hawk - hunt finder. "I want to hunt elk by my cabin" -> the hunts that
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
  if (!HU) fetch('data/hunt_units_2026.json').then(r => r.json()).then(j => { HU = j; if (tab === 'seasons') render(); }).catch(() => { HU = { hunts: {} }; });
  if (!ODDS) loadOdds();
  if (!UNITS) fetch('data/units_geo.json').then(r => r.json()).then(j => { UNITS = j.units; if (tab === 'seasons') render(); }).catch(() => {});
}
/* Read the sentence. Anything not found becomes a question. */
function fParse(text) {
  /* Fishing is asked first. Utah's waters borrow the names of its game ("Sheep Creek
     Lake", "Quail Creek Reservoir", "Duck Fork"), so a sentence about fishing would
     otherwise be answered as a hunt. fishParse hands back nothing when the sentence
     is not about fishing. */
  /* Until the fishing rules arrive no water's name is known, so the "fish" in "deer
     near Fish Lake" cannot be told from a fishing word. While they are on their way,
     an animal to hunt and no fish means a hunt; the sentence is read again when they land. */
  if (typeof fishParse === 'function') { const fq_ = fishParse(text); if (fq_ && !(fq_.pending && !fq_.sp && typeof fGame === 'function' && fGame(fWords(text)))) return { text, fish: fq_ }; }
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
  for (const g of F_BIRD_GAPS) if (g[1].test(st)) { q.gap = g; break; }
  if (!q.gap) for (const b of F_BIRDS) if (b[2].test(st)) { q.bird = b; break; }
  if (!q.gap && !q.bird) for (const [k, re] of F_SPECIES) if (re.test(st)) { q.sp = k; break; }
  for (const [k, re] of F_WEAPON) if (re.test(t)) { q.wp = k; break; }
  const m = /(\d{1,2})\s*(?:bonus|preference)?\s*(?:points?|pts)/.exec(t); if (m) q.pt = +m[1];
  let hitAlias = null;
  for (const h of (DB.config.homes || [])) {
    const a = (h.aliases || []).find(x => t.includes(fWords(x)));
    if (a) { hitAlias = a; q.place = { kind: 'home', id: h.id, label: h.label, lat: h.lat, lon: h.lon }; break; }
  }
  /* "boulder" and "fishlake" are Pete's own words for the Torrey country AND the leading
     words of real hunt units (Boulder Elk, Boulder/Kaiparowits, Fishlake). The home wins,
     because they are his words for his own places - but silently swallowing a unit name
     would plan the wrong hunt, so the collision is surfaced and he can switch in one tap.
     Only aliases he chose are tested this way, which keeps it from firing on common words. */
  if (hitAlias && UNITS) {
    const needle = fWords(hitAlias).trimEnd();                 // " boulder"
    const bases = [...new Set(UNITS.map(u => u.n.split(',')[0]))];
    const hits = bases.filter(b => fWords(b) === fWords(hitAlias) || fWords(b).startsWith(needle + ' '));
    if (hits.length) q.alsoUnit = hits.map(b => ({ label: b, units: UNITS.filter(u => u.n.split(',')[0] === b).map(u => u.n) }));
  }
  if (!q.place && /\b(here|where i am|my location|gps|right now)\b/.test(t)) q.place = { kind: 'gps' };
  if (!q.place && UNITS) {                                   // a unit named outright, longest match wins
    const hit = fUnitNames().find(([needle]) => t.includes(needle));
    if (hit) q.place = { kind: 'unit', label: hit[1], units: UNITS.filter(u => u.n.split(',')[0] === hit[1]).map(u => u.n) };
  }
  /* Nothing to hunt was named and a water was. If it is not also the name of a hunt
     unit, the sentence is about that water, and fishing can answer it. If it is both
     ("Panguitch Lake"), the hunt finder keeps it and offers the water in one tap. */
  if (wtr && !q.sp && !q.bird && !q.gap && !q.wp && !(q.place && q.place.kind === 'unit') && !(typeof F_HUNT_WORD !== 'undefined' && F_HUNT_WORD.test(wtr.rest))) return { text, fish: fishParse(text, true) };
  if (wtr2) q.alsoWater = wtr2.needle;
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
   access points, which already hold a drive time from each home.

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
   about rather than the home toggle at the top of the screen. */
const fHomeId = place => place ? (place.kind === 'home' ? place.id : null) : home;   // no place named: use the header toggle
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
    const h = (DB.config.homes || []).find(x => x.id === hid);
    return h ? miles(h.lat, h.lon, p.lat, p.lon) * 1.4 : 1e9;
  };
  return pts.sort((a, b) => key(a) - key(b));
}
function fBirdView(q) {
  const bird = q.bird, place = q.place, hid = fHomeId(place);
  const hrec = hid && (DB.config.homes || []).find(x => x.id === hid);
  const zone = hrec ? fCountyZone(hrec.county) : null;
  const zoned = !Array.isArray(bird[3]);                 // ducks: the answer depends on the zone
  const pts = fBirdPlaces(bird, place);
  let h = `<div class="sec-title">${esc(bird[1])}${place ? ' &middot; ' + esc(place.label || 'here') : ''}</div>`;

  {
    /* The zone that governs is the one you are STANDING in, not the one you
       drove from. Torrey is in the Southern Zone, but every waterfowl access
       point the app carries is a northern marsh - quoting southern dates over a
       list of northern places would be a trap. So the seasons shown cover the
       home's zone and every zone the listed places are actually in. */
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
  let h = `<form id="findform" style="margin-top:12px"><input class="search" id="findq" placeholder="pheasant near home, elk by my cabin, or trout near the cabin" value="${esc(fq.text)}"><div class="acts" style="padding:8px 0 0"><button class="btn" type="submit">Find hunts</button></div></form>
    <p class="fine" style="padding-left:2px">Try: "elk by the cabin", "pheasant near home", "chukar where I am", "archery deer near Torrey", "limited entry elk Wasatch, 7 points", "trout near the cabin", "Strawberry Reservoir rules". Works with no signal.</p>`;
  if (!q) return h;
  if (q.fish) return h + (FR ? fStale(fNow(), null, false) : '') + fishAnswer(q.fish) + (FR ? F_FOOT() : '');    // fishing answers from the guidebook rules and UDWR's places
  if (q.gap) return h + fGapNotice(q.gap);                 // named it, but there is no data to stand behind
  if (q.bird) return h + fBirdView(q);                     // birds answer from seasons + access, not hunt units
  if (!HU || !UNITS) return h + '<p class="empty">Loading the hunt lists&hellip;</p>';
  // Questions first
  const water = q.alsoWater ? `<div class="warnbox" style="margin-top:4px"><b>That sentence also names a water.</b> This answer is about hunting. For the fishing rules:</div>
    <div class="chipsrow"><button class="chip" data-fask="usewater" data-fval="${esc(q.alsoWater)}">Fishing at ${esc(q.alsoWater)}</button></div>` : '';
  if (!q.sp) return h + water + fAsk('What do you want to hunt?', Object.entries(F_LABEL).concat(F_BIRDS.map(b => ['bird:' + b[0], F_BIRD_CHIP[b[0]]])), 'sp');
  if (!q.place) return h + fAsk('Where?', (DB.config.homes || []).map(x => [x.id, x.label]).concat([['gps', 'Where I am now']]), 'place') + '<p class="fine" style="padding-left:2px">Or name a unit in the sentence, like "Wasatch Mtns" or "Book Cliffs".</p>';
  if (q.place.kind === 'gps' && !q.place.lat) return h + `<p class="empty">Getting a GPS fix&hellip;</p>`;
  const myUnits = q.place.units || (q.place.lat ? unitsAt(q.place.lon, q.place.lat).map(u => u.n) : []);
  if (!myUnits.length) return h + `<p class="empty">No hunt boundary found under ${esc(q.place.label || 'that spot')}. Try naming a unit.</p>`;
  const res = fResults(q, myUnits);
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
const fAsk = (question, opts, key) => `<div class="sec-title">${esc(question)}</div><div class="chipsrow">${opts.map(([v, l]) => `<button class="chip" data-fask="${key}" data-fval="${esc(v)}">${esc(l)}</button>`).join('')}</div>`;
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
  if (fq.parsed.place && fq.parsed.place.kind === 'gps' && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(p => { fq.parsed.place = { kind: 'gps', label: 'where I am', lat: p.coords.latitude, lon: p.coords.longitude }; render(); },
      () => { fq.parsed.place = null; render(); }, { enableHighAccuracy: true, timeout: 15000 });
  }
  render();
}
document.addEventListener('submit', e => { if (e.target.id === 'findform') { e.preventDefault(); fRun($('findq').value.trim()); } });
document.addEventListener('click', e => {
  const t = e.target.closest('[data-fask]'); if (!t) return;
  fq.touched = true;                                       // answers given by tapping are not thrown away by a later re-read
  const q = (fq.parsed && !fq.parsed.fish) ? fq.parsed : fParse(''); const v = t.dataset.fval;
  if (t.dataset.fask === 'sp') { if (v.indexOf('bird:') === 0) { q.bird = fBird(v.slice(5)); q.sp = null; } else { q.sp = v; q.bird = null; } }
  if (t.dataset.fask === 'usewater') { fq.parsed = { text: fq.text, fish: fishParse(v, true) }; render(); return; }
  if (t.dataset.fask === 'useunit') { q.place = { kind: 'unit', label: v, units: (UNITS || []).filter(u => u.n.split(',')[0] === v).map(u => u.n) }; q.alsoUnit = null; }
  if (t.dataset.fask === 'wp') q.wp = v === 'any' ? null : v, q.wpAsked = true;
  if (t.dataset.fask === 'place') { const h = (DB.config.homes || []).find(x => x.id === v); q.place = h ? { kind: 'home', id: h.id, label: h.label, lat: h.lat, lon: h.lon } : { kind: 'gps' }; if (!h) { fq.parsed = q; fRun(fq.text); return; } }
  fq.parsed = q; render();
});
