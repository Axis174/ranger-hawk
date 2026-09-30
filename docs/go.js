/* Ranger Hawk - the front door.

   Two problems, one panel. Pete tested the app on his phone and said he both
   could not find the tab he wanted AND was not sure what the app could do for
   him. So this opens on things he can THUMB - real rows built from today's
   date, the seasons that are actually open, his deadlines and his trip plan -
   with the full list of everything underneath, and typing only as a fallback.

   The box is never focused when the panel opens. Cold hands at 5am do not want
   a keyboard covering half the screen; they want something to press. Tap the
   box and the keyboard comes, and then the sentences the finders already
   understand work: "elk by the cabin", "trout near home".

   Loaded after the other screens; shares their globals ($, esc, openSheet,
   closeSheet, render, tab, DB, home, TABS, upcoming, openNow, drive, fRun,
   fishRun, acList, TRIP, tripOverdue). */
'use strict';

/* The four screens that stay on the bar, in order. Everything else lives here.
   Changing this array is the whole of "put Access back on the bar". */
const GO_BAR = ['today', 'map', 'fish', 'seasons'];

/* Every place in the app, with the words someone might reach for. Titles are
   what he would say out loud, not what the code calls them. */
const GO_DEST = [
  { id: 'find', title: 'Find a hunt', sub: 'Say what you want to hunt and where', tab: 'seasons', mode: 'find',
    keys: ['find a hunt', 'find hunt', 'what can i hunt', 'where can i hunt', 'search hunts'], weak: ['hunt'] },
  { id: 'dates', title: 'Season dates', sub: 'What is open, and what opens next', tab: 'seasons', mode: 'dates',
    keys: ['season dates', 'what is open', 'whats open', 'open now', 'seasons'], weak: ['season', 'dates'] },
  { id: 'odds', title: 'Draw odds', sub: "Last year's results at your points", tab: 'seasons', mode: 'draw',
    keys: ['draw odds', 'odds', 'bonus points', 'preference points', 'draw results'], weak: ['draw', 'points', 'application'] },
  { id: 'fish', title: 'Fishing', sub: 'Waters, rules and limits', tab: 'fish',
    keys: ['fishing', 'fish', 'trout', 'kokanee', 'tiger muskie', 'fishing rules'], weak: ['water', 'waters', 'lake', 'reservoir', 'limit', 'limits'] },
  { id: 'access', title: 'Places to go', sub: 'Access points by drive from home', tab: 'access',
    keys: ['where can i go', 'access points', 'walk in access', 'walk-in access', 'wia', 'wma'], weak: ['access', 'place', 'places', 'park', 'parking'] },
  { id: 'map', title: 'Map', sub: 'Offline map, land ownership, roads', tab: 'map',
    keys: ['map', 'offline map', 'ownership', 'land ownership'], weak: ['land', 'boundary', 'boundaries', 'roads', 'gps'] },
  { id: 'cams', title: 'Trail cameras', sub: 'Your camera log, all on this phone', tab: 'cams',
    keys: ['cam', 'cams', 'camera', 'cameras', 'trail camera', 'trail cameras'], weak: ['photos', 'pictures'] },
  { id: 'remind', title: 'Reminders and permits', sub: 'Deadlines and what you hold', tab: 'remind',
    keys: ['remind', 'reminder', 'reminders', 'deadline', 'deadlines', 'my permits'], weak: ['permit', 'permits', 'calendar', 'apply'] },
  { id: 'contacts', title: 'Landowners and calls', sub: 'Who you must phone before you go', tab: 'contacts',
    keys: ['contacts', 'landowner', 'landowners', 'who do i call', 'dwr office'], weak: ['contact', 'call', 'calls', 'phone', 'dwr', 'office', 'permission'] },
  { id: 'tags', title: 'Landowner tags, 16 states', sub: 'What can and cannot be sold', tab: 'contacts',
    keys: ['landowner tag', 'landowner tags', 'voucher', 'vouchers', 'cwmu'], weak: ['tag', 'tags'] },
  { id: 'trip', title: 'Trip plan', sub: 'Tell someone where you are going', tab: 'today', act: 'trip',
    keys: ['trip plan', 'exit plan', 'tell someone', 'back by'], weak: ['trip', 'safety'] },
  { id: 'truck', title: 'Back to the truck', sub: 'Bearing and distance, works with no signal', tab: 'today', act: 'truck',
    keys: ['back to truck', 'back to the truck', 'where am i', 'my location', 'coordinates'], weak: ['truck', 'lost', 'sar', 'rescue'] }
];

/* ------------------------------------------------------- suggestions ---- */
/* Real rows from real state. Nothing invented: if there is nothing worth
   suggesting the section simply does not appear. Ordered by what would ruin
   his day first. */
function goSuggest() {
  const out = [];
  const push = (title, sub, dest, extra) => out.push(Object.assign({ title, sub }, dest, extra || {}));

  // 1. Past your back-by time. Nothing outranks this.
  if (typeof tripOverdue === 'function' && tripOverdue()) {
    push('You are past your back-by time', 'Tell your contact, or read your position to Search and Rescue',
      { tab: 'today', act: 'truck' }, { urgent: true });
  }
  // 2. A truck is pinned, so walking back is one tap.
  else if (typeof TRIP !== 'undefined' && TRIP && TRIP.truck) {
    push('Back to the truck', 'Bearing and distance from where you stand', { tab: 'today', act: 'truck' });
  }

  // 3. Deadlines the Remind screen already calls critical or near.
  try {
    const due = upcoming().filter(x => x.st.k === 'crit' || x.st.k === 'soon').slice(0, 2);
    /* deadlineState gives days remaining as .n, not a sentence. Say the number:
       "Coming up" tells him nothing he can act on. */
    due.forEach(x => push(x.d.title,
      x.st.n === 0 ? 'Today' : x.st.n === 1 ? 'Tomorrow' : 'In ' + x.st.n + ' days',
      { tab: 'remind' }, { urgent: x.st.k === 'crit' }));
  } catch (e) { /* deadlines not loaded */ }

  // 4. Seasons opening within a week - the thing he would kick himself for missing.
  try {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const soon = (DB.seasons.seasons || []).map(s => {
      const a = d0(s.start);
      return { s, days: Math.round((a - now) / 86400000) };
    }).filter(x => x.days > 0 && x.days <= 7).sort((a, b) => a.days - b.days);
    const seen = {};
    soon.forEach(x => {
      const key = x.s.name.split(' - ')[0].split(',')[0];
      if (seen[key] || out.length >= 5) return;
      seen[key] = 1;
      push(key + (x.days === 1 ? ' opens tomorrow' : ' opens in ' + x.days + ' days'),
        x.s.bag && x.s.bag !== '-' ? x.s.bag : x.s.area, { tab: 'seasons', mode: 'dates' });
    });
  } catch (e) { /* seasons not loaded */ }

  // 5. Something open right now that he could act on today.
  try {
    const open = (DB.seasons.seasons || []).filter(s => {
      const now = new Date(); now.setHours(0, 0, 0, 0);
      return d0(s.start) <= now && now <= d0(s.end) && s.group !== 'turkey';
    });
    if (open.length && out.length < 6) {
      const pick = open[0].name.split(' - ')[0].split(',')[0];
      push(pick + ' is open today', 'Find somewhere to go', { tab: 'seasons', mode: 'find' }, { q: pick.toLowerCase() });
    }
  } catch (e) { /* seasons not loaded */ }

  // 6. A property he has to phone before he sets foot on it.
  try {
    if (typeof acList === 'function' && acList().length && out.length < 6) {
      push('Places that need a call first', acList().length + ' properties want the owner phoned', { tab: 'contacts' });
    }
  } catch (e) { /* contacts not loaded */ }

  return out.slice(0, 6);
}

/* ------------------------------------------------------------ routing ---- */
/* How a typed sentence is routed. In this order:
   a. The whole text is a screen's own word or name: open that screen.
   b. Take any water's name out of the sentence. Fish Lake, Duck Fork and the WMA
      and walk-in waters carry screen words and animals in their names, and a
      name is not a request: "deer near fish lake", "kokanee at deer creek".
   c. What is left names a fish, something to hunt, or a hunting word.
   d. A distinctive screen word other than Fish's still wins outright, because
      "deer cams" and "draw odds elk" name a screen and the hunt finder would
      otherwise claim them. Then: something to hunt and no fish -> the hunt
      finder. A WMA or walk-in property said on its own -> Access. A fish, a
      water, or anything fishParse can use -> the fishing finder. Otherwise the
      screen word the sentence holds, with no search, as v27 did, and failing
      that v27's fallback, the hunt finder. */
const goNorm = text => ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';

function goHit(t, list, except) {
  let best = null;
  for (const d of GO_DEST) if (d.id !== except) for (const k of (d[list] || [])) {
    if (t.indexOf(' ' + k + ' ') >= 0 && (!best || k.length > best.len)) best = { dest: d, len: k.length };
  }
  return best ? best.dest : null;
}

/* a. Nothing but one screen's own word or its name. */
function goExact(text) {
  const t = goNorm(text).trim();
  if (!t) return null;
  return GO_DEST.find(d => (d.keys || []).concat(d.weak || []).indexOf(t) >= 0 || goNorm(d.title).trim() === t) || null;
}

/* b. The sentence with a water's name taken out: full names first, then the
   two-word short names. Needs the fishing data; without it the sentence is used whole. */
function goWater(text) {
  const t = goNorm(text);
  let w = null;
  try { if (typeof fishWaterIn === 'function') w = fishWaterIn(t, 'two'); } catch (e) { /* not loaded */ }
  /* A county said as a county is a county ("carbon county"), as fishParse reads it. */
  try { if (w && typeof fCountyIn === 'function') { const co = fCountyIn(t); if (co && (' ' + co.phrase + ' ').indexOf(' ' + w.needle + ' ') >= 0) w = null; } } catch (e) { /* not loaded */ }
  return { t, w, d: w ? goNorm(w.rest) : t };
}

/* c. A fish by name, from the list fishParse reads. */
function goFish(d) {
  if (typeof F_FISH === 'undefined') return false;
  const s = typeof F_FISH_NOISE !== 'undefined' ? d.replace(F_FISH_NOISE, ' ') : d;
  return F_FISH.some(f => f[2].test(s));
}
/* Something to hunt by name, from the hunt finder's own lists (F_SPECIES, F_BIRDS).
   Those lists are in the page from the start, so this works before the fishing
   data has arrived. */
function goGame(d) {
  try { return typeof fGame === 'function' && fGame(d); } catch (e) { return false; }
}
/* A hunting word: the Hunt screen's own words and a few more. Season dates' words
   are left out, because "season" and "open" are fishing words too. A fishing word
   in the same sentence ("fishing permit") cancels it. */
const GO_HUNT_MORE = ['hunting', 'hunts', 'hunter', 'hunters', 'tag', 'tags', 'permit', 'permits'];
function goHuntWord(d) {
  if (typeof F_FISH_WORD !== 'undefined' && F_FISH_WORD.test(d)) return false;
  return GO_DEST.filter(x => x.tab === 'seasons' && x.id !== 'dates')
    .reduce((a, x) => a.concat(x.keys || [], x.weak || []), GO_HUNT_MORE)
    .some(k => d.indexOf(' ' + k + ' ') >= 0);
}

/* d. Where the text goes: { dest } opens a screen, { dest, q } opens it with a search,
   { hunt } and { fish } run that finder on the whole sentence. */
function goRoute(text) {
  const raw = String(text || '').trim();
  const exact = goExact(raw);
  if (exact) return { dest: exact };
  const { t, w, d } = goWater(raw);
  const strong = goHit(d, 'keys', 'fish');
  if (strong) return { dest: strong, q: raw };
  const fish = goFish(d), game = goGame(d), word = goHuntWord(d);
  if ((game || word) && !fish) {
    if (game) return { hunt: true };
    /* A hunting word and no animal: its screen, as v27 ("my points" -> Draw odds). The
       Find a hunt screen is the hunt finder, so it gets the sentence: "hunt near fish lake". */
    const s = goHit(d, 'weak', 'fish');
    return s ? { dest: s, q: raw } : { hunt: true };
  }
  const acc = GO_DEST.find(x => x.id === 'access');
  if (w && !d.trim() && acc.keys.some(k => goNorm(w.needle).indexOf(' ' + k + ' ') >= 0)) return { dest: acc };   /* "stewart lake wma": the hunting property, as v27 */
  /* What fishParse can use: anything it finds in a fishing sentence, or a water by a
     one-word name ("strawberry", "pineview") in any sentence, as v27 did. */
  let f = null, one = null;
  try { if (typeof fishParse === 'function') { f = fishParse(raw, false); one = fishParse(raw, true); } } catch (e) { /* not loaded */ }
  if (fish || w || (one && one.water) || (f && (f.sp || f.water || f.county || f.protected || f.place || f.unknown))) return { fish: true };
  const s = goHit(t, 'keys') || goHit(t, 'weak');   /* "i want to go fishing": the plain screen, as v27 */
  return s ? { dest: s } : { hunt: true };
}

/* Scroll the tags heading to the top. The first time, the tag data is still
   loading and the screen is too short to get it there, so try again until it
   lands - unless he has gone somewhere else in the meantime. */
let GO_LAND_T = null;
function goLandStop() { if (GO_LAND_T) clearTimeout(GO_LAND_T); GO_LAND_T = null; }
function goLand(n) {
  GO_LAND_T = null;
  if (tab !== 'contacts') return;
  const a = $('lotags');
  if (a) a.scrollIntoView();
  if (typeof LOT !== 'undefined' && !LOT && n < 20) GO_LAND_T = setTimeout(() => goLand(n + 1), 150);
}

function goOpen(dest, extra) {
  goLandStop();
  closeSheet();
  if (dest.act === 'truck' && typeof tripBack === 'function') { tripBack(); return; }
  if (dest.act === 'trip' && typeof tripForm === 'function') { tripForm(); return; }
  tab = dest.tab;
  if (dest.mode && typeof seasonsMode !== 'undefined') seasonsMode = dest.mode;
  render();
  /* The tags row lives at the foot of Contacts, so land on it rather than on the
     top of a long screen. (v27 set a contactsMode that nothing declares or reads.) */
  if (dest.id === 'tags' && $('lotags')) goLand(0); else window.scrollTo(0, 0);
  const q = (extra && extra.q) || null;
  if (q && dest.mode === 'find' && typeof fRun === 'function') setTimeout(() => fRun(q), 30);
}

/* What a typed sentence does. */
function goSubmit(text) {
  const raw = String(text || '').trim();
  if (!raw) return;
  goLandStop();
  const r = goRoute(raw);
  if (r.dest) { goOpen(r.dest, r.q ? { q: r.q } : {}); return; }
  closeSheet();
  if (r.fish) { tab = 'fish'; render(); window.scrollTo(0, 0); if (typeof fishRun === 'function') setTimeout(() => fishRun(raw), 30); return; }
  tab = 'seasons';
  if (typeof seasonsMode !== 'undefined') seasonsMode = 'find';
  render();
  window.scrollTo(0, 0);
  if (typeof fRun === 'function') setTimeout(() => fRun(raw), 30);
}

/* -------------------------------------------------------------- panel ---- */
const goRow = (title, sub, attrs, urgent) =>
  `<button class="row" ${attrs} style="--g:${urgent ? 'var(--crit)' : 'var(--accent)'}"><span class="pill"></span>
    <span><span class="t">${esc(title)}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ''}</span>
    <span class="v"></span></button>`;

function goPanelHtml() {
  const sugg = goSuggest();
  let h = `<h3>What do you want to do?</h3>
    <div style="padding:0 16px"><input class="search" id="goq" placeholder="Type or say it - elk by the cabin, trout near home" autocomplete="off"></div>`;

  if (sugg.length) {
    h += `<div class="sec-title">Right now</div><div class="card">`
      + sugg.map((s, i) => goRow(s.title, s.sub, `data-go-s="${i}"`, s.urgent)).join('')
      + `</div>`;
  }

  h += `<div class="sec-title">Everything</div><div class="card">`
    + GO_DEST.map(d => goRow(d.title, d.sub, `data-go-d="${esc(d.id)}"`)).join('')
    + `</div>
    <p class="fine" style="padding:10px 16px 0">Tap anything above, or type a sentence and the app will work out where it goes. It all works with no signal.</p>`;
  return h;
}

let GO_SUGG = [];
function goPanel() {
  GO_SUGG = goSuggest();
  openSheet(goPanelHtml());   /* deliberately not focused: the list should be visible first */
}

/* Any tap that changes the screen ends a pending landing on the tags. */
document.addEventListener('click', e => { if (e.target.closest && e.target.closest('[data-tab],[data-go],[data-go-d],[data-go-s]')) goLandStop(); }, true);

document.addEventListener('click', e => {
  const t = e.target.closest('[data-go],[data-go-d],[data-go-s]');
  if (!t) return;
  if ('go' in t.dataset) { goPanel(); return; }
  if (t.dataset.goD) { const d = GO_DEST.find(x => x.id === t.dataset.goD); if (d) goOpen(d, {}); return; }
  if (t.dataset.goS) { const s = GO_SUGG[+t.dataset.goS]; if (s) goOpen(s, s); return; }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target && e.target.id === 'goq') { e.preventDefault(); goSubmit(e.target.value); }
});
