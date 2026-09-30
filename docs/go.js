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
/* Screen words are tested BEFORE the sentence parsers. fParse claims any text
   holding an animal name, so "deer cams" and "draw odds elk" would both be
   dragged into the hunt finder and the screen he actually asked for would never
   open. Same trap as "deer near antelope island" in the September audit. */
function goNames(text) {          /* does this sentence name an animal or a water? */
  try { if (typeof fParse === 'function') { const q = fParse(text); if (q && (q.sp || q.bird || q.gap)) return true; } } catch (e) { /* not loaded */ }
  try { if (typeof fishParse === 'function') { const f = fishParse(text, true); if (f && (f.water || f.species)) return true; } } catch (e) { /* not loaded */ }
  return false;
}

function goHit(t, list) {
  let best = null;
  for (const d of GO_DEST) for (const k of (d[list] || [])) {
    if (t.indexOf(' ' + k + ' ') >= 0 && (!best || k.length > best.len)) best = { dest: d, len: k.length };
  }
  return best ? best.dest : null;
}

/* Distinctive words win outright, because "deer cams" and "draw odds elk" name a screen and
   fParse would otherwise claim them for the hunt finder. Generic words lose to a named
   species or water, because "pheasant near north salt lake" holds the word "lake" and is
   plainly not a fishing question. Same trap as "deer near antelope island" in the audit. */
function goMatch(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  if (t.trim() === '') return null;
  const strong = goHit(t, 'keys');
  if (strong) return strong;
  if (goNames(text)) return null;                 /* let the finders answer a real sentence */
  return goHit(t, 'weak');
}

/* Is the text nothing but one of this screen's own words? */
function goBare(dest, text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (dest.keys || []).concat(dest.weak || []).indexOf(t) >= 0;
}

/* Scroll the tags heading to the top. The first time, the tag data is still
   loading and the screen is too short to get it there, so try again until it lands. */
function goLand(n) {
  const a = $('lotags');
  if (a) a.scrollIntoView();
  if (typeof LOT !== 'undefined' && !LOT && n < 20) setTimeout(() => goLand(n + 1), 150);
}

function goOpen(dest, extra) {
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
  if (q && dest.tab === 'fish' && typeof fishRun === 'function') setTimeout(() => fishRun(q), 30);
}

/* What a typed sentence does. Screen words first, then the finders. */
function goSubmit(text) {
  const raw = String(text || '').trim();
  if (!raw) return;
  const dest = goMatch(raw);
  /* A screen word alone opens the screen. A sentence that carries more than the
     screen word ("trout near home", "fishing in carbon county") also goes to that
     screen's finder with the whole sentence, or the Menu's own example does nothing. */
  if (dest) { goOpen(dest, goBare(dest, raw) ? {} : { q: raw }); return; }
  // Not a screen name. Let the parsers that already understand sentences try.
  if (typeof fishParse === 'function') {
    try {
      const f = fishParse(raw, true);
      if (f && (f.water || f.species)) { closeSheet(); tab = 'fish'; render(); setTimeout(() => fishRun(raw), 30); return; }
    } catch (e) { /* fall through */ }
  }
  closeSheet();
  tab = 'seasons';
  if (typeof seasonsMode !== 'undefined') seasonsMode = 'find';
  render();
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
