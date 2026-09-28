/* Ranger Hawk - fishing.

   Utah fishing is not one table. It is a statewide set of limits, a list of
   named waters that each override part of it, groups of waters that share a rule,
   and signed emergency changes UDWR posts during the year. The guidebook states
   the order itself: "On waters that have a specific rule, that rule takes
   precedence over the general rules."

   How this file stays out of trouble:

   1. UDWR's WORDS ARE THE RECORD. Every rule is stored in the guidebook's own
      wording with its page, and that wording is what is shown. The index beside
      each rule (fx) only SORTS it - what it is about, which statewide limits it
      touches, which dates it covers. The app never works out a merged limit.
   2. The layers, highest first: emergency change (by date) > the water's own rule
      (by stretch) > a group rule (community waters) > statewide. A higher layer
      replaces only what it speaks to; everything else still comes from below.
   3. It FAILS TOWARD CAUTION. A rule the index could not sort, a place that could
      not be matched to a water, a notice nobody has read in yet: each is shown in
      UDWR's words with a warning. None of them is ever read as "statewide applies".
   4. Dates are worked out on the phone, in UTAH'S time whatever the phone is set
      to, so a change that has ended drops off by itself with no signal, and
      "until Oct. 1" is read as through Sept. 30.
   5. Every warning travels with the rule. A sheet opened from the map, from a
      search or from the hunt finder carries the same warnings as the Fish tab.

   Data: data/fishing_rules.json (scraper/build_fishing.py, from the guidebook PDF),
   data/fishing_places.json (scraper/build_fishing_places.py, from UDWR's layers),
   data/fishing_notices.json (the daily job, UDWR's list of emergency changes).

   Loaded after app.js; shares its globals ($, esc, miles, DB, home, render, tab). */
'use strict';

let FR = null, FP = null, FNT = null, fishState = 'idle';
let fish = { mode: 'near', q: '', parsed: null, county: '', show: 12 };
try { fish.mode = localStorage.getItem('ha.fishmode') || 'near'; } catch (e) { /* private mode */ }

let fishTried = 0;
const F_NOPLACES = () => ({ places: [], extra_counties: {}, no_place: {}, missing: true });
function fishLoad(again) {
  if (fishState === 'loading' || fishState === 'ready') return;
  if (fishState === 'failed' && !again && Date.now() - fishTried < 20000) return;   // a failed load is tried again, but not in a loop
  fishState = 'loading'; fishTried = Date.now();
  const grab = f => fetch('data/' + f, { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).then(j => (j && !j.offline ? j : null)).catch(() => null);
  Promise.all([grab('fishing_rules.json'), grab('fishing_places.json'), grab('fishing_notices.json')]).then(([r, p, n]) => {
    FR = (r && r.waters && r.statewide && r.community && r._edition) ? r : null;
    FP = p && Array.isArray(p.places) ? p : F_NOPLACES();
    FNT = n;
    fishState = FR ? 'ready' : 'failed';
    if (FR) fishIndex();
    /* A sentence typed into the hunt finder before the rules arrived was read without
       them, so "fishing at Sheep Creek Lake" went to bighorn sheep. Read it again. */
    if (FR && typeof fq !== 'undefined' && fq.text && !fq.touched && typeof fParse === 'function') fq.parsed = fParse(fq.text);
    if (tab === 'fish' || tab === 'today' || (tab === 'seasons' && typeof seasonsMode !== 'undefined' && seasonsMode === 'find')) render();
  });
}
if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('online', () => { if (fishState === 'failed') fishLoad(true); });

/* ------------------------------------------------------------- index ---- */
let FW = {}, FCOM = {}, FROW = {}, FAM = {}, FPL = {}, FBYW = {}, FTWIN = {}, FLINKED = true;
const F_TOPICS = ['closed', 'limit', 'release', 'tackle', 'boat', 'method', 'keep', 'access', 'info'];
const fPtOk = p => typeof p === 'string' ? /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(p)
  : !!(p && typeof p === 'object' && p.m >= 1 && p.m <= 12 && (p.n === -1 || (p.n >= 1 && p.n <= 5)) && (p.h == null || (p.h >= 0 && p.h <= 23)));
/* An index entry the app does not fully understand is treated as not sorted at all:
   a misspelt topic, a limit that names no row, a date it cannot read. The rule is
   then shown with a warning instead of being passed over in silence. */
function fFxOk(fx) {
  if (!fx || F_TOPICS.indexOf(fx.t) < 0) return false;
  const spans = fx.open || fx.w;
  if (spans != null && !(Array.isArray(spans) && spans.length && spans.every(x => Array.isArray(x) && x.length === 2 && x.every(fPtOk)))) return false;
  if (fx.t === 'closed' && fx.scope !== 'all' && fx.scope !== 'part') return false;
  if ((fx.t === 'limit' || fx.t === 'release') && fx.rows !== 'all' && !(Array.isArray(fx.rows) && fx.rows.length && fx.rows.every(r => FROW[r]))) return false;
  return true;
}
function fFix(ru) { if (!ru || !Array.isArray(ru.fx) || !ru.fx.length || !ru.fx.every(fFxOk)) ru.fx = [{ t: 'unsorted' }]; }
function fishIndex() {
  FW = {}; FCOM = {}; FROW = {}; FAM = {}; FPL = {}; FBYW = {}; FTWIN = {};
  fNames = null; fShort = null;
  FR.statewide.limits.forEach(l => { FROW[l.row] = l; });
  FR.waters.forEach(w => { FW[w.id] = w; (w.reaches || []).forEach(r => (r.rules || []).forEach(fFix)); });
  FR.community.rules.forEach(fFix); (FR.community.notes || []).forEach(fFix);
  FR.community.members.forEach(m => {
    FCOM['community:' + m.id] = m;
    // A pond can be a community water and have an entry of its own (Burraston Ponds).
    const own = FR.waters.find(x => x.kind === 'water' && x.name === m.name && x.counties.indexOf(m.county) >= 0);
    if (own) { FTWIN['community:' + m.id] = own.id; FTWIN[own.id] = 'community:' + m.id; }
  });
  (FR.amendments || []).forEach(a => { (a.rules || []).forEach(fFix); const k = a.community ? 'community:' + a.community : a.water; (FAM[k] = FAM[k] || []).push(a); });
  /* The places were matched to one build of the rules. Against any other build a
     stretch letter or a "not on a listed stretch" decision could point at the wrong
     thing, so the matching is switched off and every place falls back to its county. */
  FLINKED = !!(FP && !FP.missing && FR._shape && FP._rules_shape === FR._shape);
  /* A water the guidebook does not list, known only from an emergency notice, may
     have been read in after the places were built. Its place is found here, by the
     same strict rule the builder uses: the whole name and the county. */
  const late = FR.waters.filter(w => w.kind === 'notice');
  ((FP && FP.places) || []).forEach(p => {
    if (!FLINKED) { p.w = []; p.r = null; p.rel = []; }
    else late.forEach(w => { if (fKey(p.n.split(',')[0]) === fKey(w.name) && w.counties.indexOf(p.c) >= 0 && (p.w || []).indexOf(w.id) < 0) p.w = (p.w || []).concat([w.id]); });
    FPL[p.id] = p; (p.w || []).forEach(w => { (FBYW[w] = FBYW[w] || []).push(p); });
  });
}
const fExtra = id => (FP && FP.extra_counties && FP.extra_counties[id]) || [];
const fCounties = w => (w.counties || [w.county]).concat(fExtra(w.id));

/* ------------------------------------------------------------- dates ---- */
/* A point in a span is "MM-DD", or {n, m, h, d}: the nth Saturday of month m
   (n = -1 for the last), at hour h, d days later. The guidebook writes its
   openers as "6 a.m. on the second Saturday of July", so the hour matters. */
function fPoint(pt, year, end) {
  let m, day, h = null;
  if (typeof pt === 'string') { [m, day] = pt.split('-').map(Number); }
  else {
    m = pt.m;
    if (pt.n > 0) {
      const first = new Date(year, m - 1, 1).getDay();
      day = 1 + ((6 - first + 7) % 7) + 7 * (pt.n - 1);
    } else {
      const last = new Date(year, m, 0);
      day = last.getDate() - ((last.getDay() - 6 + 7) % 7);
    }
    day += (pt.d || 0);
    if (pt.h != null) h = pt.h;
  }
  /* The END of a span is the first moment outside it. "Through April 30" ends when
     May 1 begins; "through 6 a.m. on the second Saturday" ends at 6 a.m. sharp. */
  if (h != null) return new Date(year, m - 1, day, h, 0, 0);
  return new Date(year, m - 1, day + (end ? 1 : 0), 0, 0, 0);
}
/* Is `now` inside the span? A span whose end falls before its start runs over
   the new year. */
function fSpan(span, now) {
  const y = now.getFullYear(), a = fPoint(span[0], y, false), b = fPoint(span[1], y, true);
  const wraps = b <= a;
  return { on: wraps ? (now >= a || now < b) : (now >= a && now < b), a, b, wraps };
}
const fAnyOn = (spans, now) => (spans || []).some(s => fSpan(s, now).on);
const fWhen = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
  ((d.getHours() === 6 && d.getMinutes() === 0) ? ', 6 a.m.' : '');
const fDay = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fDayAfter = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d + 1); };   // not "+ 24 hours": some days are 23 or 25 hours long
/* Utah's clock. Every date in the rules is a Utah date, and a phone at Lake Powell
   or on the Nevada line can be keeping another state's time. The result is a Date
   whose own fields read as the wall clock in Utah, which is what the spans are
   built from. */
let fUtahOk = true;
function fUtah(d) {
  try {
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(d).forEach(x => { p[x.type] = +x.value; });
    if (p.year && p.month && p.day) return new Date(p.year, p.month - 1, p.day, (p.hour || 0) % 24, p.minute || 0, p.second || 0);
  } catch (e) { /* no time zone data on this phone: its own clock is the best there is */ }
  fUtahOk = false;
  return d;
}
const fNow = () => (fish.now ? new Date(fish.now) : fUtah(new Date()));   // fish.now is set by the tests only, and is Utah time
/* The dates a span covers in the year the rules are for, e.g. "Jan 1 to Jul 11, 6 a.m., 2026".
   The last day is printed as the guidebook prints it, not as the moment after it. */
function fSpansText(spans) {
  const y = FR._edition.year, noYear = d => fWhen(d).replace(', ' + d.getFullYear(), '');
  return (spans || []).map(s => {
    const a = fPoint(s[0], y, false), wraps = fPoint(s[1], y, true) <= a, b = fPoint(s[1], wraps ? y + 1 : y, false);
    return wraps ? noYear(a) + ', ' + y + ' to ' + noYear(b) + ', ' + (y + 1) : noYear(a) + ' to ' + noYear(b) + ', ' + y;
  }).join('; ');
}
/* When is a water shut, and when does that next change? Several rules can close
   the same stretch ("CLOSED Jan. 1 through ... April and Nov. 1-Dec. 31", "Open to
   fishing on the first Saturday of May through Oct. 31"), and one closure can run
   straight into the next over the new year, so the answer is worked out from all of
   them together: every date any of them names is tried in turn, and the first one
   at which the water is no longer in the state it is in now is the answer. */
const fShutAt = (fxs, t) => fxs.some(fx => fx.open ? !fAnyOn(fx.open, t) : fx.w ? fAnyOn(fx.w, t) : true);
function fFlip(fxs, now) {
  const y = now.getFullYear(), at = [], was = fShutAt(fxs, now);
  fxs.forEach(fx => (fx.open || fx.w || []).forEach(x => [y, y + 1].forEach(yy => { at.push(fPoint(x[0], yy, false)); at.push(fPoint(x[1], yy, true)); })));
  at.sort((a, b) => a - b);
  for (const d of at) if (d > now && fShutAt(fxs, d) !== was) return d;
  return null;
}
/* The guidebook is for one calendar year. Outside it nothing here is current. */
function fEdition(now) {
  const e = FR._edition, y = now.getFullYear();
  return { year: e.year, current: y === e.year, late: y > e.year, early: y < e.year };
}

/* --------------------------------------------------- emergency changes ---- */
function fAmendState(a, now) {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const from = fDay(a.from), last = fDay(a.last_day);
  /* UDWR has taken the notice off its list, or reworded it, since it was read in.
     A change that raised a limit is set aside: the guidebook rule is the stricter
     one, so falling back to it cannot get anyone cited. A change that closed a
     water or lowered a limit is kept, for the same reason, and flagged. */
  const held = fHeld()[a.notice];
  if (held && t >= from && t <= last) {
    if (a.direction === 'more') return { k: 'held', why: held, txt: 'Set aside' };
    return { k: 'on', why: held, left: Math.round((last - t) / 86400000), txt: 'In force - check' };
  }
  /* A change the app cannot place in time is never applied. */
  if (isNaN(from) || isNaN(last)) return { k: 'held', why: 'dates', txt: 'Dates not read' };
  if (t < from) return { k: 'later', txt: 'Starts ' + fWhen(from) };
  if (t > last) return { k: 'ended', txt: 'Ended ' + fWhen(last) };
  const left = Math.round((last - t) / 86400000);
  return { k: 'on', left, txt: left === 0 ? 'Last day today' : left === 1 ? 'Ends tomorrow' : left <= 21 ? left + ' days left' : 'In force' };
}
/* Notices read into the rules that UDWR has since removed ('gone') or reworded
   ('changed'). Empty when the daily list is missing or failed: then nothing can
   be concluded, and the changes run on their own dates. */
function fHeld() {
  const out = {};
  if (!FNT || FNT.ok === false || !FNT.notices) return out;
  const listed = {}; FNT.notices.forEach(n => { listed[n.slug] = n; });
  (FR.amendments || []).forEach(a => {
    if (!listed[a.notice]) out[a.notice] = 'gone';
    else if (fReworded(a, listed[a.notice])) out[a.notice] = 'changed';
  });
  return out;
}
/* The summary on UDWR's page reads differently, or the signed PDF behind it is no
   longer the file that was read in. */
const fReworded = (a, n) => !!((a.sha && n.sha && a.sha !== n.sha) || (a.pdf_sha && n.pdf_sha && a.pdf_sha !== n.pdf_sha));
/* A notice UDWR lists that nobody has read in yet, if it names this water. */
const fKey = s => String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
function fUnreadFor(name, counties) {
  if (!FNT || !FNT.notices) return [];
  const built = {}; (FR.amendments || []).forEach(a => { built[a.notice] = 1; });
  /* Tied to a water only when the names are the same. A notice under any other
     spelling is still listed on every sheet, by fStale, so it cannot be missed; it
     is just not said to be "for this water". */
  const n0 = fKey(name);
  return FNT.notices.filter(n => !built[n.slug] && n0 && fKey(n.name || n.title) === n0 && (!n.county || counties.some(c => String(n.county).indexOf(c) >= 0)));
}
/* What UDWR lists today, set against what has been read into the rules. */
function fNotices() {
  const built = {}; (FR.amendments || []).forEach(a => { built[a.notice] = a; });
  const out = { unread: [], changed: [], gone: [], stale: null, failed: false, book: false, list: false };
  if (!FNT) { out.failed = true; return out; }
  const listed = {};
  (FNT.notices || []).forEach(n => {
    listed[n.slug] = n;
    if (!built[n.slug]) out.unread.push(n);
    else if (fReworded(built[n.slug], n)) out.changed.push(n);
  });
  if (FNT.ok !== false) Object.keys(built).forEach(s => { if (!listed[s]) out.gone.push(built[s]); });
  const last = FNT.last_ok ? new Date(FNT.last_ok) : null;
  const today = fish.now ? new Date(fish.now) : new Date();
  if (!last || isNaN(last) || (today - last) / 86400000 > 3) out.stale = (last && !isNaN(last)) ? last : null, out.old = true;
  if (FNT.ok === false) out.failed = true;
  if (FNT.guidebook && FNT.guidebook.sha && FNT.guidebook.sha !== FR._edition.sha) out.book = true;
  /* UDWR's list reads differently from the day the rules were built, and no notice
     the app could pick out accounts for it: a notice set out in a way the reader
     did not expect, a correction, a new heading. */
  const seen = FR._notices_other || [];
  out.fresh = (FNT.other || []).map(x => x[1]).filter(x => seen.indexOf(x) < 0);
  /* Any difference at all. An edit can hide behind a notice that is unread or
     reworded, so the warning does not wait for the difference to be unexplained. */
  if (FNT.ok !== false && (out.fresh.length || (FNT.sha && FR._notices_sha && FNT.sha !== FR._notices_sha))) out.list = true;
  return out;
}

/* ------------------------------------------------------ one rule, now ---- */
/* Does this effect bite today? Undated effects always do. */
function fOn(fx, now) {
  if (fx.open) return { on: !fAnyOn(fx.open, now), dated: true };       // open between dates = closed outside them
  if (fx.w) return { on: fAnyOn(fx.w, now), dated: true };
  return { on: true, dated: false };
}
function fRuleNow(ru, now, gone) {
  const st = { on: false, dated: false, gone: !!(gone && gone[ru.id]), unsorted: false, day: (ru.fx || []).some(fx => fx.daylight) };
  (ru.fx || []).forEach(fx => {
    if (fx.t === 'unsorted') { st.unsorted = true; st.on = true; return; }
    if (fx.t === 'info') return;
    const o = fOn(fx, now);
    if (fx.t === 'access' && fx.open) { st.dated = true; st.on = true; return; }
    st.dated = st.dated || o.dated;
    st.on = st.on || o.on;
  });
  if (!(ru.fx || []).some(fx => fx.t !== 'info')) st.on = true;
  return st;
}
/* The standing of one set of rules (a stretch, a group, a change) right now. */
const fShuts = fx => (fx.t === 'closed' && fx.scope !== 'part') || (fx.t === 'access' && !!fx.open);
function fStanding(rules, now, gone, over) {
  const s = { closed: false, part: false, opens: null, closes: null, art: null, cr: false, boat: [], rows: {}, named: {}, all: false, later: false, unsorted: false, keeps: false, day: false, byChange: false };
  const shut = (over || []).slice();                 // every effect that closes the whole stretch, read together
  if (over && over.length && fShutAt(over, now)) s.byChange = true;
  (rules || []).forEach(ru => {
    if (gone && gone[ru.id]) return;
    (ru.fx || []).forEach(fx => {
      if (fx.t === 'unsorted') { s.unsorted = true; s.all = true; return; }
      const o = fOn(fx, now);
      if (fx.daylight && (o.on !== !!fx.open)) s.day = true;       // an open window that is open now, or a rule in force
      if (fx.t === 'closed' || (fx.t === 'access' && fx.open)) {
        if (fx.scope === 'part') { if (o.on) s.part = true; return; }
        shut.push(fx);
        return;
      }
      if (fx.t === 'tackle' && fx.art) { if (o.on) s.art = (s.art === 'f' || fx.art === 'f') ? 'f' : 'fl'; else s.later = true; }
      if (fx.t === 'boat' && fx.boat && s.boat.indexOf(fx.boat) < 0) s.boat.push(fx.boat);
      if (fx.t === 'limit' || fx.t === 'release') {
        if (!o.on) { s.later = true; return; }
        s.keeps = true;
        if (fx.cr) s.cr = true;
        if (fx.rows === 'all') s.all = true;
        else (fx.rows || []).forEach(r => { s.rows[r] = 1; (fx.sp || []).forEach(n => { const a = (s.named[r] = s.named[r] || []); if (a.indexOf(n) < 0) a.push(n); }); });
      }
    });
  });
  if (shut.length) {
    s.closed = fShutAt(shut, now);
    const d = fFlip(shut, now);
    if (s.closed) s.opens = d; else s.closes = d;
  }
  return s;
}
const F_BOAT = { motor: 'No motors', none: 'No boats or float tubes', shore: 'Shore only', wakeless: 'Wakeless' };
function fChips(s, am, res) {
  if (FR && !fEdition(fNow()).current) return [['crit', 'Rules out of date']];
  const c = [];
  if (res && res.unread && res.unread.length) c.push(['crit', 'New notice - not built in']);
  if (res && res.changes.some(x => x.st.k === 'held')) c.push(['crit', 'Change set aside']);
  if (am) c.push(['crit', 'Emergency change']);
  if (s.closed) c.push(['crit', 'Closed now']);
  if (s.part) c.push(['soon', 'Part closed']);
  if (s.day && !s.closed) c.push(['soon', 'Daylight hours only']);
  if (s.cr) c.push(['soon', 'Catch and release']);
  if (s.art) c.push(['soon', s.art === 'f' ? 'Flies only' : 'Flies and lures only']);
  s.boat.forEach(b => c.push(['shut', F_BOAT[b] || b]));
  if (s.keeps && !s.cr) c.push(['open', 'Own limits']);
  if (s.unsorted) c.push(['crit', 'Read the rule']);
  /* An entry whose rules are all dated and none of them bites today. */
  if (!c.length && res) c.push(['open', 'Nothing in force today']);
  return c;
}
const fChipHtml = c => c.map(x => `<span class="state ${x[0]}">${esc(x[1])}</span>`).join(' ');

/* ------------------------------------------------ one water, resolved ---- */
/* Everything that bears on a guidebook entry today, layer by layer. `only`
   narrows a many-stretch river to the stretches a place is known to be on. */
function fResolve(id, now, only) {
  const out = { id, layers: [], changes: [], gone: {}, stand: [], name: '', counties: [] };
  /* A pond that is a community water AND has an entry of its own is one water with
     two layers, whichever of its two names it was opened by. */
  const com = FCOM[id] || FCOM[FTWIN[id]] || null, comId = FCOM[id] ? id : (com ? FTWIN[id] : null);
  let w = FW[id] || FW[FTWIN[id]] || null;
  if (!w && !com) return null;
  out.name = w ? w.name : com.name;
  out.counties = w ? fCounties(w) : [com.county];
  const take = (a, lent) => {
    const st = fAmendState(a, now);
    /* A change posted for the water the guidebook points to. The notice does not name
       this water. One that tightens a rule is applied here, because that is the
       safer reading; one that loosens a rule is shown and not applied. */
    const c = { a, st, lent: lent || null };
    if (lent && a.direction === 'more' && st.k === 'on') c.st = { k: 'lent', txt: 'Not applied here' };
    out.changes.push(c);
    if (c.st.k === 'on') (a.replaces || []).forEach(r => { out.gone[r] = a; });
  };
  (FAM[id] || []).forEach(a => take(a));
  if (FTWIN[id]) (FAM[FTWIN[id]] || []).forEach(a => take(a));
  if (w && w.kind === 'pointer' && FW[w.see.water]) {
    const via = w; w = FW[w.see.water]; only = only || via.see.reaches || null; out.via = via; out.target = w;
    (FAM[w.id] || []).forEach(a => take(a, w.name));
  }
  out.unread = fUnreadFor(out.name, out.counties).concat(out.target ? fUnreadFor(out.target.name, fCounties(out.target)) : []).filter((x, i, a) => a.indexOf(x) === i);
  if (w) {
    (w.reaches || []).forEach(r => {
      if (only && only !== 'none' && r.key && only.indexOf(r.key) < 0) return;
      if (r.see) { out.layers.push({ kind: 'see', title: w.name, key: r.key, where: r.where, see: r.see, rules: [] }); return; }
      out.layers.push({ kind: 'own', title: w.name, page: w.page, key: r.key, where: r.where, rules: r.rules || [], desc: w.desc });
    });
    out.entry = w; out.only = only;
  }
  if (com) {
    const notes = (FR.community.notes || []).filter(n => (n.members || []).indexOf(com.id) >= 0);
    out.layers.push({ kind: 'community', title: 'Community fishing waters', page: FR.community.page, rules: FR.community.rules.concat(notes) });
    out.com = comId;
  }
  return fStand(out, now);
}
/* Two names for one water count once. */
const fOnce = ids => ids.filter((x, i, a) => a.indexOf(x) === i && !(FTWIN[x] && x.indexOf('community:') === 0 && a.indexOf(FTWIN[x]) >= 0));
function fStand(out, now) {
  let act = [];
  out.changes.forEach(c => { if (c.st.k === 'on') act = act.concat(c.a.rules); });
  out.change = fStanding(act, now, null);
  /* A change that shuts the water shuts every stretch of it, and the day a stretch
     opens is worked out with the change counted in. */
  const over = [];
  out.changes.forEach(c => {
    if (c.st.k !== 'on' && c.st.k !== 'later') return;
    (c.a.rules || []).forEach(ru => (ru.fx || []).forEach(fx => {
      if (!fShuts(fx)) return;
      /* A closure with no dates of its own runs for as long as the change does. */
      over.push((fx.w || fx.open) ? fx : Object.assign({}, fx, { w: [[String(c.a.from).slice(5), String(c.a.last_day).slice(5)]] }));
    }));
  });
  out.layers.forEach(l => { l.stand = fStanding(l.rules, now, out.gone, over); });
  // Rows of the statewide table that something above has taken over today.
  const rows = {}, named = {}; let all = out.change.all, unsorted = out.change.unsorted, later = false;
  const name = (st) => Object.keys(st.named).forEach(r => { st.named[r].forEach(n => { const a = (named[r] = named[r] || []); if (a.indexOf(n) < 0) a.push(n); }); });
  Object.keys(out.change.rows).forEach(r => { rows[r] = 'change'; }); name(out.change);
  out.layers.forEach(l => {
    if (out.only === 'none' && l.kind === 'own') return;
    if (l.stand.all) all = true;
    if (l.stand.unsorted) unsorted = true;
    if (l.stand.later) later = true;
    Object.keys(l.stand.rows).forEach(r => { rows[r] = rows[r] || (l.kind === 'community' ? 'group' : 'own'); }); name(l.stand);
  });
  out.rows = rows; out.named = named; out.all = all; out.unsorted = unsorted; out.later = later;
  return out;
}
/* One line of chips for a list row: the worst case across the stretches. */
function fSummary(res) {
  const s = { closed: false, part: false, art: null, cr: false, boat: [], keeps: false, unsorted: false, mixed: false, day: false };
  const own = res.layers.filter(l => l.kind !== 'see');
  const use = res.only === 'none' ? own.filter(l => l.kind !== 'own') : own;
  const fold = t => {
    if (t.part) s.part = true;
    if (t.cr) s.cr = true;
    if (t.art) s.art = (s.art === 'f' || t.art === 'f') ? 'f' : 'fl';
    t.boat.forEach(b => { if (s.boat.indexOf(b) < 0) s.boat.push(b); });
    if (t.keeps) s.keeps = true;
    if (t.unsorted) s.unsorted = true;
    if (t.day) s.day = true;
  };
  use.forEach(l => fold(l.stand));
  /* A stretch is one of the water's own; a group rule lies over all of them. */
  const mine = use.filter(l => l.kind === 'own'), over = use.filter(l => l.kind !== 'own');
  const shut = mine.filter(l => l.stand.closed).length;
  if (over.some(l => l.stand.closed) || (shut && shut === mine.length)) s.closed = true; else if (shut) s.part = true;
  if (mine.length > 1 && !res.only) s.mixed = true;
  /* An emergency change is read the same way as any other layer: it can close a
     water or make it catch and release, not only change a limit. */
  fold(res.change);
  if (res.change.closed) s.closed = true;
  return s;
}

/* -------------------------------------------------------- rendering ---- */
const F_TOPIC = { closed: 'Closure', limit: 'Limit', release: 'Release', tackle: 'Tackle', boat: 'Boats', method: 'Method', keep: 'Keeping fish', access: 'Access', info: 'Note', unsorted: 'Read this' };
function fRuleHtml(ru, now, gone, byChange) {
  const st = fRuleNow(ru, now, gone), topic = ((ru.fx || [])[0] || {}).t || 'info';
  let tag = '', cls = 'frule';
  const spans = (ru.fx || []).map(fx => fx.open || fx.w).filter(Boolean)[0];
  if (st.gone) { cls += ' gone'; tag = `<span class="state shut">Replaced until ${esc(fWhen(fDayAfter(gone[ru.id].last_day)))}</span>`; }
  else if (st.unsorted) tag = '<span class="state crit">Not sorted - read it</span>';
  else if (!fEdition(now).current) tag = '';          // nothing is worked out from last year's dates
  else if (byChange && (ru.fx || []).some(fShuts)) tag = '<span class="state crit">Closed by the change above</span>';
  else if (spans && (ru.fx || []).some(fx => fx.open)) tag = `<span class="state ${fAnyOn(spans, now) ? (st.day ? 'soon' : 'open') : 'crit'}">${fAnyOn(spans, now) ? (st.day ? 'Open today, daylight hours only' : 'Open now') : 'Closed now'}</span>`;
  else if (st.dated) { if (st.on) tag = '<span class="state soon">In force today</span>'; else { cls += ' off'; tag = '<span class="state shut">Not today</span>'; } }
  const dates = spans ? `<span class="fdates">${esc(fSpansText(spans))}</span>` : '';
  const items = (ru.items || []).length ? '<ul>' + ru.items.map(i => `<li>${esc(i)}</li>`).join('') + '</ul>' : '';
  return `<div class="${cls}"><span class="ftopic">${esc(F_TOPIC[topic] || topic)}</span><span class="ftext">${esc(ru.text)}${items}${dates}</span>${tag ? `<span class="ftag">${tag}</span>` : ''}</div>`;
}
function fChangeHtml(c, now) {
  const a = c.a, on = c.st.k === 'on';
  const end = new Date(fDay(a.last_day).getTime());
  let why = c.st.why === 'dates' ? `<div class="warnbox fbad" style="margin:0;border-radius:0"><b>The app could not read the dates of this change,</b> so it has not applied it. The guidebook rule is shown.</div>`
    : c.st.why ? `<div class="warnbox fbad" style="margin:0;border-radius:0"><b>${c.st.why === 'gone' ? 'UDWR no longer lists this notice.' : 'UDWR has reworded this notice since it was read in.'}</b>
    ${c.st.k === 'held' ? 'It raised a limit, so the app has set it aside and shows the guidebook rule, which is the stricter one.' : 'It tightened a rule, so the app keeps showing it.'} Check <a href="https://wildlife.utah.gov/guidebooks" target="_blank" rel="noopener">UDWR's list</a> before you rely on either.</div>` : '';
  if (c.lent) why += `<div class="warnbox" style="margin:0;border-radius:0"><b>Posted for ${esc(c.lent)}, not for this water by name.</b> The guidebook sends this water to ${esc(c.lent)} for its rules.
    ${c.st.k === 'lent' ? 'The change loosens a rule, so the app has <b>not applied it here</b>: the guidebook rule below is the safer reading.' : on ? 'The change tightens a rule, so the app shows it as in force here, which is the safer reading.' : ''} Read the notice to see what it covers.</div>`;
  const st = fStanding(a.rules, now, null), chips = on ? fChips(Object.assign({}, st, { keeps: false }), false) : [];
  return `<div class="fchange ${on ? 'on' : 'off'}">
    <div class="fch"><b>Emergency change${on ? '' : c.st.k === 'ended' ? ' - ended' : c.st.k === 'held' ? ' - set aside' : c.st.k === 'lent' ? ' - not applied here' : ' - not yet in force'}</b><span class="state ${on ? 'crit' : 'shut'}">${esc(c.st.txt)}</span></div>${why}
    ${chips.length ? `<div class="fchipline" style="padding:8px 12px 0">${fChipHtml(chips)}</div>` : ''}
    ${a.rules.map(r => `<div class="frule"><span class="ftopic">${esc(F_TOPIC[(r.fx[0] || {}).t] || '')}</span><span class="ftext">${esc(r.text)}</span>${(r.fx || []).some(fx => fx.t === 'unsorted') ? '<span class="ftag"><span class="state crit">Not sorted - read it</span></span>' : ''}</div>`).join('')}
    ${a.also ? `<div class="frule"><span class="ftopic">Stays</span><span class="ftext">${esc(a.also)}</span></div>` : ''}
    ${(a.stands || []).map(x => `<div class="frule"><span class="ftopic">Still stands</span><span class="ftext"><i>${esc(x.about)}:</i> ${esc(x.text)}<span class="fdates">Not changed by this notice &middot; guidebook p. ${esc(x.page)}</span></span></div>`).join('')}
    ${a.rules.some(r => /spearfishing/i.test(r.text)) ? `<div class="frule"><span class="ftopic">Note</span><span class="ftext">The guidebook's rules for underwater spearfishing (pp. ${esc(((FR.spear || {}).pages || [19, 21]).join('-'))}) apply to spearfishing here.</span></div>` : ''}
    <p class="fine">UDWR: in effect ${esc(fWhen(fDay(a.from)))} until ${esc(fWhen(fDay(a.until)))}. The app treats <b>${esc(fWhen(end))}</b> as the last day, to stay on the safe side. All other rules in the guidebook remain in effect.
    <a href="${esc(a.url)}" target="_blank" rel="noopener">The signed notice</a></p></div>`;
}
/* The statewide table, whole. A row that a rule above speaks to is MARKED, never
   hidden and never replaced by a number of the app's own. Many water rules change
   only part of a row ("No limit for brook trout" leaves the other trout at the
   statewide 4) or build on it ("goes toward the statewide trout limit"), so the
   statewide figure has to stay in view beside them. */
const F_WHO = { change: 'emergency change', own: 'rule above', group: 'community rule' };
function fStatewideHtml(res, maybe) {
  const L = FR.statewide.limits.filter(l => l.row !== 'community' && l.row !== 'kokanee');
  if (!fEdition(fNow()).current) return `<p class="fine" style="padding:10px 16px 0"><b>As printed for ${esc(FR._edition.year)}.</b> The app does not say which of these a rule above changes, because that depends on dates in a year that is over.</p>
      <table class="flim chg">${L.map(l => `<tr><td>${esc(l.name)}</td><td>${esc(l.limit)}</td></tr>`).join('')}</table>`;
  const taken = res ? res.rows : {}, all = !!(res && res.all), none = !res;
  const hit = l => all || taken[l.row], set = L.filter(hit), keep = L.filter(l => !hit(l));
  let h = '';
  if (res && res.unsorted) h += `<div class="warnbox fbad" style="margin:12px 16px 0"><b>A rule above could not be sorted by the app.</b> Treat every row below as changed until you have read it.</div>`;
  if (set.length) {
    h += `<p class="fine" style="padding:10px 16px 0"><b>Changed at this water.</b> A rule above speaks to these fish, and UDWR's order is that "that rule takes precedence over the general rules." The statewide figure is printed beside each so you can see what the rule starts from. <b>It is not the limit here unless the rule above leaves it alone.</b></p>
      <table class="flim chg">${set.map(l => { const nm = (res.named || {})[l.row] || [];
        return `<tr><td>${esc(l.name)}<span class="fdates">see the ${esc(F_WHO[taken[l.row] || (res.change.all ? 'change' : 'own')] || 'rule above')}${nm.length ? ', which names ' + esc(nm.join(', ')) : ''}</span></td><td>statewide: ${esc(l.limit)}</td></tr>`; }).join('')}</table>`;
  }
  if (res && res.later) h += `<p class="fine" style="padding:6px 16px 0">A dated rule above is not in force today. When it starts, it takes precedence for the fish it names.</p>`;
  if (keep.length) h += `<p class="fine" style="padding:10px 16px 0"><b>${none ? 'Statewide limits.' : 'Unchanged here.'}</b> ${none ? '' : 'No rule above names these fish, so the statewide limit applies.'}</p>
      <table class="flim">${keep.map(l => `<tr><td>${esc(l.name)}${maybe && maybe[l.row] ? '<span class="fdates">a group rule below may change this</span>' : ''}</td><td>${esc(l.limit)}</td></tr>`).join('')}</table>`;
  return h;
}
/* Rules the guidebook sets for a GROUP of waters without naming each one: "Utah
   Lake tributaries ... including but not limited to", "Boulder Mountain lakes and
   reservoirs". The app cannot know that a lake or creek is one of them, so every
   group in the same county, of the same kind of water, is shown as one that MAY
   apply. It is never counted as applying and never counted as not applying. */
const F_STREAM = /\b(river|creek|fork|stream|canal|hollow|wash|canyon|tributar(y|ies)|inflow|inlet)\b/i;
/* true for a stream, false for a lake, null when the name does not say (an access
   property, a park): then every group in the county is offered. */
function fIsStream(name, kind) {
  if (kind) return kind === 'stream';
  const n = String(name).replace(/\b(reservoir|lake|pond)s? (tributar(y|ies)|inflow|inlet)\b/i, 'tributaries');
  if (/\b(reservoir|lake|lakes|pond|ponds)\b/i.test(n)) return false;
  return F_STREAM.test(n) ? true : null;
}
/* The water a group of tributaries runs into: "Bear Lake tributaries" -> "bear lake". */
function fParent(g) {
  const to = /\btributaries to (.+)$/i.exec(g.name);
  return fKey(to ? to[1] : g.name.replace(/,? (and its |and other )?(tributar(y|ies)|inflow|inlet)\b.*$/i, ''));
}
function fGroupsFor(name, counties, kind, skip) {
  const stream = fIsStream(name, kind), me = fKey(name);
  return FR.waters.filter(g => g.group && g.kind === 'water' && (skip || []).indexOf(g.id) < 0 &&
    fCounties(g).some(c => counties.indexOf(c) >= 0) &&
    (stream === null || /lakes and streams/i.test(g.name) ? true : /lakes and reservoirs/i.test(g.name) ? !stream
      /* A tributary rule can reach into the lake: Bear Lake's covers "that area extending
         from the mouth out into the lake 1,000 feet". So the lake is offered it too. */
      : (stream || fParent(g) === me)));
}
function fGroupsHtml(groups, name, now) {
  if (!groups.length) return { h: '', rows: {} };
  const rows = {}, low = String(name).toLowerCase();
  let h = `<div class="sec-title" style="padding:0 16px">Group rules that may also cover this water &middot; ${groups.length}</div>
    <p class="fine" style="padding:6px 16px 0">The guidebook sets some rules for a group of waters without naming each one. ${groups.length === 1 ? 'This group is' : 'These groups are'} in the same county. <b>Read the description: if it fits the water you are on, the rule applies to you.</b></p>`;
  groups.forEach(g => {
    let body = '', out = false;
    (g.reaches || []).forEach(r => {
      if (r.see) { body += fLayerHtml({ kind: 'see', key: r.key, where: r.where, see: r.see }, now, null, null); return; }
      const st = fStanding(r.rules, now, null);
      if (st.all) FR.statewide.limits.forEach(l => { rows[l.row] = 1; }); else Object.keys(st.rows).forEach(k => { rows[k] = 1; });
      r.rules.forEach(ru => (ru.fx || []).forEach(fx => { if (fx.except && fx.except.some(x => x.toLowerCase() === low)) out = true; }));
      body += fLayerHtml({ kind: 'own', key: r.key, where: r.where || g.desc, rules: r.rules, stand: st }, now, null, null);
    });
    h += `<details class="fgroup" open><summary>${esc(g.name)} <span class="fdates">${esc(fCounties(g).join(', '))} &middot; p. ${esc(g.page)}</span></summary>
      ${out ? `<div class="warnbox" style="margin:10px 16px 0"><b>The guidebook names ${esc(name)} as an exception</b> to a rule of this group. Read the rule to see which.</div>` : ''}${body}</details>`;
  });
  return { h, rows };
}
/* Underwater spearfishing is a section of its own in the guidebook (pp. 19-21). It
   is shown word for word on the waters it names and nothing is worked out from it. */
function fSpearFor(id, name, counties) {
  const out = [], me = fKey(name);
  ((FR.spear || {}).sections || []).forEach(sec => sec.entries.forEach(e => {
    const near = e.counties.some(c => counties.indexOf(c) >= 0);
    /* An entry that stands over a list ("Uinta Mountains ... at the following
       high-elevation lakes") is matched through the list, never by its own name:
       "Uinta Mountains, Mirror Lake Highway" is not one of the 17 lakes. */
    const same = (id && e.water) ? (e.water === id && near) : (!e.named && near && fKey(e.name) === me);
    /* A water named INSIDE an entry's rules, from a list a person made and the build
       checked against the page. Whole names only: "Fish Lake (Weber River drainage)"
       names Fish Lake and says nothing about the Weber River. A name the guidebook
       qualifies ("Weber River drainage") is never matched by name: the app cannot
       tell which Fish Lake a place is. */
    const inside = !same && near && (e.named || []).some(x => (id && x.w) ? x.w === id : (!x.q && fKey(x.n) === me));
    if (same || inside) out.push({ sec, e });
  }));
  return out;
}
/* The general rules of the spearfishing section, word for word. */
function fSpearGeneral(open) {
  const g = (FR.spear || {}).general || [];
  if (!g.length) return '';
  return `<details class="fgroup"${open ? ' open' : ''}><summary>General rules for spearfishing <span class="fdates">guidebook pp. ${esc((FR.spear.pages || []).join('-'))}</span></summary>
    <div class="fstretch">${g.map(r => `<div class="frule"><span class="ftopic">${esc(r.head)}</span><span class="ftext">${esc(r.text)}${(r.items || []).length ? '<ul>' + r.items.map(i => `<li>${esc(i)}</li>`).join('') + '</ul>' : ''}<span class="fdates">p. ${esc(r.page)}</span></span></div>`).join('')}</div></details>`;
}
/* `id` is the entry in hand; `opened` says an emergency change in force opens it. */
function fSpearHtml(list, id, opened) {
  const sp = FR.spear || {}, pg = (sp.pages || []).join('-');
  if (!sp.sections) return '';
  const named = (sp.general || []).filter(r => (r.waters || []).indexOf(id) >= 0);
  if (!list.length && !named.length) {
    /* Not in the lists. The guidebook opens only listed waters to spearfishing for
       game fish, so the sheet says what the app found and quotes the guidebook. */
    const open = sp.sections.find(x => x.id === 'open');
    return `<div class="sec-title" style="padding:0 16px">Underwater spearfishing &middot; guidebook pp. ${esc(pg)}</div>
      <p class="fine" style="padding:6px 16px 0">Only if you spearfish. ${opened === 'opens' ? 'An emergency change above opens this water to spearfishing while it is in force. The guidebook\'s own lists do not name it.' : opened ? 'An emergency change above speaks to spearfishing at this water. Read it. The guidebook\'s own lists do not name this water.' : 'The app did not find this water in the guidebook\'s lists of waters open to spearfishing.'} The guidebook says: "${esc(open ? open.intro : '')}"</p>` + fSpearGeneral(false);
  }
  let h = `<div class="sec-title" style="padding:0 16px">Underwater spearfishing &middot; guidebook pp. ${esc(pg)}</div>
    <p class="fine" style="padding:6px 16px 0">Only if you spearfish. The guidebook names this water in its spearfishing section, as below. Its general rules for spearfishing follow.</p>`;
  if (named.length) h += `<div class="fstretch">${named.map(r => `<div class="frule"><span class="ftopic">Spearfishing</span><span class="ftext">${esc(r.text)}<span class="fdates">p. ${esc(r.page)}</span></span></div>`).join('')}</div>`;
  list.forEach(x => {
    h += `<div class="fstretch"><div class="fwhere"><b>${esc(x.sec.title)}.</b> ${esc(x.sec.intro)}</div>
      <div class="frule"><span class="ftopic">Named as</span><span class="ftext">${esc(x.e.name)}, ${esc(x.e.counties.join(', '))} ${x.e.counties.length > 1 ? 'counties' : 'County'}<span class="fdates">p. ${esc(x.e.page)}</span></span></div>
      ${x.e.rules.map(r => `<div class="frule"><span class="ftopic">Spearfishing</span><span class="ftext">${esc(r.text)}${(r.items || []).length ? '<ul>' + r.items.map(i => `<li>${esc(i)}</li>`).join('') + '</ul>' : ''}</span></div>`).join('')}</div>`;
  });
  return h + fSpearGeneral(false);
}
/* "Opens May 2", "Closes Nov 1", or nothing. A date in a later year than the
   guidebook's is never printed: next year's guidebook sets it, not this one. */
function fOpens(st, now) {
  if (!fEdition(now).current) return '';
  const y = FR._edition.year;
  if (st.closed) {
    if (!st.opens || st.opens.getFullYear() > y) return `<span class="fdates">Closed for the rest of ${esc(y)}. The ${esc(y + 1)} guidebook will say when it opens.</span>`;
    return `<span class="fdates">Opens ${esc(fWhen(st.opens))}</span>`;
  }
  if (st.closes && st.closes.getFullYear() <= y) {
    /* A closure that starts with the day is printed as the last day open. */
    const d = st.closes, whole = d.getHours() === 0 && d.getMinutes() === 0;
    return `<span class="fdates">${whole ? 'Last day open ' + esc(fWhen(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1))) : 'Closes ' + esc(fWhen(d))}</span>`;
  }
  return '';
}
function fLayerHtml(l, now, gone, res) {
  if (l.kind === 'see') return `<div class="fstretch"><div class="fwhere">${l.key ? '(' + esc(l.key) + ') ' : ''}${esc(l.where || '')}</div>
    <button class="row" data-fw="${esc(l.see)}" style="--g:var(--accent)"><span class="pill"></span><span><span class="t">See ${esc((FW[l.see] || {}).name || '')}</span><span class="s">The guidebook points there for this stretch</span></span><span class="v">&rsaquo;</span></button></div>`;
  const chips = fEdition(now).current ? fChips(l.stand, false) : [];
  const opens = fOpens(l.stand, now);
  const where = l.where || (l.kind === 'own' ? l.desc : '');
  return `<div class="fstretch">
    ${where ? `<div class="fwhere">${l.key ? '(' + esc(l.key) + ') ' : ''}${esc(where)}</div>` : ''}
    ${chips.length || opens ? `<div class="fchipline">${fChipHtml(chips)} ${opens}</div>` : ''}
    ${l.stand.byChange ? '<div class="fwhere"><b>Shut by the emergency change above.</b> The dates below are the guidebook\'s and do not open it.</div>' : ''}
    ${l.rules.map(r => fRuleHtml(r, now, gone, l.stand.byChange)).join('')}</div>`;
}
/* The whole answer for one guidebook entry. */
/* What is wrong with the rules as a whole today. It is printed on the Fish tab,
   on every sheet and on every answer the finder gives, because a sheet can be
   opened without ever passing the Fish tab. `skip` holds notices already printed
   in full for the water in hand. */
function fStale(now, skip, pad) {
  const ed = fEdition(now), n = fNotices(), m = pad === false ? '' : ' style="margin:12px 16px 0"';
  const mine = (skip || []).map(x => x.slug), other = n.unread.filter(x => mine.indexOf(x.slug) < 0);
  let h = '';
  if (ed.late) h += `<div class="warnbox fbad"${m}><b>These are the ${esc(ed.year)} rules and ${esc(ed.year)} is over.</b> The ${esc(ed.year + 1)} guidebook governs now. They are shown as printed. Do not rely on them, or on any date worked out from them.</div>`;
  if (ed.early) h += `<div class="warnbox fbad"${m}><b>These are the ${esc(ed.year)} rules.</b> This phone's date is before ${esc(ed.year)}. Do not rely on them.</div>`;
  if (n.book) h += `<div class="warnbox fbad"${m}><b>UDWR has replaced the guidebook file since these rules were built.</b> It may be a correction or next year's edition. Check anything that matters against the guidebook itself.</div>`;
  if (other.length) h += `<div class="warnbox fbad"${m}><b>UDWR has posted ${other.length === 1 ? 'a change' : other.length + ' changes'} not yet built into these rules:</b> ${other.map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>`).join('; ')}. If ${other.length === 1 ? 'it is' : 'one is'} for the water you are on, the notice governs, not what is shown here.</div>`;
  const told = x => (x.text || []).map(t => t[0] === 'li' ? '<br>&bull; ' + esc(t[1]) : '<br>' + esc(t[1])).join('');
  n.changed.forEach(x => { h += `<div class="warnbox fbad"${m}><b>UDWR has reworded its notice for ${esc(x.title)}, or replaced the signed notice, since it was read in.</b> What it says today may be about another water as well. It reads:${told(x)}<br><a href="${esc(x.url)}" target="_blank" rel="noopener">The signed notice</a></div>`; });
  n.gone.forEach(a => { h += `<div class="warnbox fbad"${m}><b>UDWR no longer lists the emergency change for ${esc(a.name)}.</b> It may have been withdrawn. Treat the guidebook rule as the one in force until you have checked.</div>`; });
  if (n.list) h += `<div class="warnbox fbad"${m}><b>UDWR's list of fishing changes is not the list these rules were built from.</b>${n.fresh.length ? ' New on it: ' + n.fresh.map(x => '"' + esc(x) + '"').join(' ') : ''} Something on it may not be shown here. <a href="https://wildlife.utah.gov/guidebooks" target="_blank" rel="noopener">Check the list</a> for the water you are on.</div>`;
  if (!fUtahOk) h += `<div class="warnbox"${m}><b>This phone could not work out the time in Utah,</b> so dates and hours are read by the phone's own clock. If it is set to another state's time, an opening or a closing can be an hour out.</div>`;
  if (n.failed || n.old) h += `<div class="warnbox"${m}><b>UDWR's list of emergency changes ${!FNT ? 'is not on this phone' : n.stale ? 'was last read ' + esc(fWhen(n.stale)) : 'could not be read'}.</b> A change posted since then will not be shown. Check wildlife.utah.gov/guidebooks when you have a signal.</div>`;
  if (FP && FP.missing) h += `<div class="warnbox"${m}><b>The list of fishing places is not on this phone yet.</b> Rules can be looked up by water; distances and places will appear once it has loaded.</div>`;
  else if (!FLINKED) h += `<div class="warnbox fbad"${m}><b>The places and the rules on this phone are from different builds,</b> so the app has stopped matching one to the other. Look the water up by name under By water.</div>`;
  return h;
}
function fEntryHtml(res, now, opt) {
  opt = opt || {};
  let h = (opt.bare ? '' : fStale(now, res.unread)) + fKokaneeNow(now);
  (res.unread || []).forEach(x => {
    h += `<div class="warnbox fbad" style="margin:12px 16px 0"><b>UDWR has posted a change for this water that is not built into the rules below.</b>
      ${x.text.map(t => t[0] === 'li' ? '<br>&bull; ' + esc(t[1]) : '<br>' + esc(t[1])).join('')}
      <br><a href="${esc(x.url)}" target="_blank" rel="noopener">The signed notice</a></div>`;
  });
  res.changes.forEach(c => { h += fChangeHtml(c, now); });
  if (res.via) h += `<p class="fine" style="padding:10px 16px 0">The guidebook lists <b>${esc(res.via.name)}</b> (${esc(res.via.counties.join(', '))} County) and says: "${esc(res.via.desc)}" ${res.only && res.only !== 'none' ? 'Shown below is the part of that entry that names it.' : 'That entry does not say which stretch, so all of it is shown.'}</p>`;
  if (res.only === 'none') h += `<div class="warnbox" style="margin:12px 16px 0"><b>This stretch is not one the guidebook lists.</b> ${esc(opt.why || '')} Statewide rules apply here${res.changes.some(c => c.st.k === 'on') ? ', and so does the emergency change above' : ''}. The listed stretches are below so you can check where you are standing.</div>`;
  const own = res.layers.filter(l => l.kind === 'own' || l.kind === 'see'), grp = res.layers.filter(l => l.kind === 'community');
  if (own.length) {
    const e = res.entry || {}, many = own.length > 1;
    h += `<div class="sec-title" style="padding:0 16px">${esc(own[0].title)}${many ? ' &middot; ' + own.length + ' stretches' : ''} &middot; guidebook p. ${esc(own[0].page || (e.page || ''))}</div>`;
    if (many && !res.only) h += `<p class="fine" style="padding:6px 16px 0"><b>The rules differ by stretch.</b> Find the stretch you are on; the app cannot tell from a single point on the map.</p>`;
    if (e.desc && many) h += `<p class="fine" style="padding:6px 16px 0">${esc(e.desc)}</p>`;
    h += own.map(l => fLayerHtml(l, now, res.gone, res)).join('');
  }
  grp.forEach(l => {
    h += `<div class="sec-title" style="padding:0 16px">${esc(l.title)} &middot; guidebook p. ${esc(l.page)}</div>
      <p class="fine" style="padding:6px 16px 0">This is one of the community fishing waters, so the rules for that group apply.</p>` + fLayerHtml(l, now, res.gone, res);
  });
  if (res.entry && res.entry.kind === 'notice') h += `<p class="fine" style="padding:10px 16px 0">The ${esc(FR._edition.year)} guidebook has no entry of its own for this water. Apart from the emergency change above, statewide rules apply.</p>`;
  if (res.entry && res.entry.near) h += `<div class="warnbox" style="margin:12px 16px 0"><b>Not the same water as:</b> ${res.entry.near.map(n => esc((FW[n] || {}).name + ' (' + ((FW[n] || {}).counties || []).join(', ') + ' County)')).join('; ')}.</div>`;
  /* A general rule that names this water is a rule about this water. */
  const gid = res.target ? res.target.id : (res.entry ? res.entry.id : res.id);
  const names = FR.statewide.rules.filter(r => (r.waters || []).indexOf(gid) >= 0);
  if (names.length && res.only !== 'none') h += `<div class="sec-title" style="padding:0 16px">General rules that name this water</div>
    <div class="fstretch">${names.map(r => `<div class="frule"><span class="ftopic">${esc(r.head)}</span><span class="ftext">${esc(r.text)}${(r.items || []).length ? '<ul>' + r.items.map(i => `<li>${esc(i)}</li>`).join('') + '</ul>' : ''}<span class="fdates">guidebook p. ${esc(r.page)}</span></span></div>`).join('')}</div>`;
  const e0 = res.entry || {}, isGroup = !!e0.group;
  const groups = isGroup || (res.layers.some(l => l.kind === 'community')) ? [] :
    fGroupsFor(opt.name || res.name, opt.counties || res.counties, opt.kind || null, [res.id].concat(res.target ? [res.target.id] : []));
  const G = fGroupsHtml(groups, opt.name || res.name, now);
  h += `<div class="sec-title" style="padding:0 16px">Statewide limits</div>` + fStatewideHtml(res, G.rows) + G.h;
  const sid = res.target ? res.target.id : (res.entry ? res.entry.id : res.id);
  const spoken = res.changes.filter(c => c.st.k === 'on').reduce((a, c) => a.concat(c.a.rules.filter(r => /spearfishing/i.test(r.text))), []);
  h += fSpearHtml(fSpearFor(sid, res.name, opt.counties || res.counties), sid, !spoken.length ? '' : spoken.every(r => /\bis open to underwater spearfishing\b/i.test(r.text)) ? 'opens' : 'speaks');
  return h;
}
const F_FOOT = () => `<p class="fine" style="padding:14px 16px 0">Rules are UDWR's own words from the ${esc(FR._edition.year)} Utah Fishing Guidebook and its posted emergency changes. They are in force Jan. 1 to Dec. 31, ${esc(FR._edition.year)}. Species and stocking are UDWR's and are not rules. <b>Not legal advice.</b> The guidebook, the signed notices and signs posted at the water are the authority.
  <a href="${esc(FR._edition.pdf)}" target="_blank" rel="noopener">Guidebook</a> &middot; <a href="https://wildlife.utah.gov/guidebooks" target="_blank" rel="noopener">Posted changes</a></p>`;

/* ------------------------------------------------------------ places ---- */
function fDrive(p, hid) {
  const d = (p.d || {})[hid || home];
  if (d) return { txt: String(d.min), sub: (p.snap || 0) > 0.5 ? 'min *' : 'min', mins: d.min };
  const h = (DB.config.homes || []).find(x => x.id === (hid || home));
  if (!h) return { txt: '--', sub: '', mins: 1e9 };
  const mi = miles(h.lat, h.lon, p.lat, p.lon);
  return { txt: mi.toFixed(0), sub: 'mi', mins: mi * 1.4 };
}
const F_ABUND = { L: 'likely', P: 'possible', I: 'invasive', X: 'protected', S: 'special' };
function fPlaceRes(p, now) {
  const ws = fOnce(p.w || []);
  if (!ws.length) return [];
  return ws.map(w => fResolve(w, now, p.r || null)).filter(Boolean);
}
const fPlaceKind = p => (p.k === 'access' || !p.k) ? null : p.k;
function fPlaceChips(p, now) {
  const rs = fPlaceRes(p, now);
  if (FR && !fEdition(now).current) return [['crit', 'Rules out of date']];
  if (!FLINKED) return [['crit', 'Not matched - look it up by water']];
  /* No chip would read as "nothing special here". A place the app could not match
     says so, and says what it found instead. */
  if (!rs.length) {
    const c = [];
    if (fUnreadFor(p.n.split(',')[0], [p.c]).length) c.push(['crit', 'New notice - not built in']);
    if (p.rel && p.rel.length) c.push(['soon', 'See related rules']);
    if (fGroupsFor(p.n.split(',')[0], [p.c], fPlaceKind(p), p.rel || []).length) c.push(['soon', 'Check group rule']);
    if (p.pt === 'Waterfowl Management Area') c.push(['soon', 'Closed unless posted open']);
    if (!c.length) c.push(['shut', 'No entry by this name']);
    return c;
  }
  let chips = [], seen = {};
  rs.forEach(res => {
    const am = res.changes.some(c => c.st.k === 'on');
    fChips(Object.assign({ boat: [] }, fSummary(res)), am, res).forEach(c => { if (!seen[c[1]]) { seen[c[1]] = 1; chips.push(c); } });
    if (fSummary(res).mixed) { if (!seen.m) { seen.m = 1; chips.push(['shut', 'Differs by stretch']); } }
  });
  if (p.cf) chips = chips.map(c => c[1] === 'Own limits' ? ['open', 'Community water'] : c);
  if (p.r === 'none') chips = chips.filter(c => c[0] === 'crit').concat([['open', 'Outside the listed stretches']]);
  if (!rs.some(r => r.com || (r.entry && r.entry.group)) && fGroupsFor(p.n.split(',')[0], [p.c], fPlaceKind(p), (p.w || []).concat(rs.map(r => r.target ? r.target.id : r.id))).length) chips.push(['soon', 'Check group rule']);
  if (!chips.length) chips.push(['open', 'No special rule today']);
  return chips;
}
function fPlaceRow(p, now, place) {
  const hid = place && place.kind === 'home' ? place.id : (place ? null : home);
  let v, sub;
  if (place && place.lat != null && place.kind !== 'home') { v = miles(place.lat, place.lon, p.lat, p.lon).toFixed(0); sub = 'mi'; }
  else { const d = fDrive(p, hid); v = d.txt; sub = d.sub; }
  const sp = (p.sp || []).filter(s => s[1] === 'L').map(s => s[0]).slice(0, 4).join(', ');
  return `<button class="row" data-fp="${esc(p.id)}" style="--g:var(--fish)"><span class="pill"></span>
    <span><span class="t">${esc(p.n)}</span><span class="s">${esc(p.c)} Co.${sp ? ' &middot; ' + esc(sp) : ''}</span>
    <span class="s fchipline">${fChipHtml(fPlaceChips(p, now))}</span></span>
    <span class="v">${esc(v)}<small>${sub}</small></span></button>`;
}
/* Every entry with its own rules in a county: the net under every place the app
   could not match by name. */
function fCountyList(county, skip) {
  const ws = FR.waters.filter(w => fCounties(w).indexOf(county) >= 0 && (skip || []).indexOf(w.id) < 0).sort((a, b) => a.name.localeCompare(b.name));
  if (!ws.length) return '';
  return `<div class="sec-title" style="padding:0 16px">Every water with its own rules in ${esc(county)} County &middot; ${ws.length}</div>
    <div class="fcounty">${ws.map(w => `<button class="chip" data-fw="${esc(w.id)}">${esc(w.name)}</button>`).join('')}</div>`;
}
function sheetFishPlace(p) {
  const now = fNow(), rs = fPlaceRes(p, now), d = p.d || {};
  const st = k => d[k] ? esc(d[k].min) + 'm' : '--';
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
  let h = `<h3>${esc(p.n)}</h3><p class="where">${esc(p.c)} County${p.br ? ' &middot; Blue Ribbon fishery' : ''}${p.cf ? ' &middot; community fishing water' : ''}${p.pt ? ' &middot; ' + esc(p.pt) : ''}</p>
    <div class="stats"><div class="stat"><div class="k">N Salt Lake</div><div class="v">${st('nsl')}</div></div>
      <div class="stat"><div class="k">Heber</div><div class="v">${st('heber')}</div></div>
      <div class="stat"><div class="k">Torrey</div><div class="v">${st('torrey')}</div></div></div>
    <div class="acts"><a class="btn" href="https://maps.apple.com/?daddr=${(p.nav || [p.lat, p.lon]).map(num).join(',')}&dirflg=d">Directions</a>
      <button class="btn ghost" data-copy="${num(p.lat)}, ${num(p.lon)}">Copy coordinates</button></div>`;
  if (p.note) h += `<div class="warnbox" style="margin:12px 16px 0">${esc(p.note)}</div>`;
  if (p.pt === 'Waterfowl Management Area') h += `<div class="warnbox" style="margin:12px 16px 0"><b>Waterfowl management areas are closed to fishing</b> unless they are posted open or listed as open in the guidebook (p. 15).${rs.length ? ' This one is listed; read its entry below.' : ' This one has no entry of its own in the guidebook, so look for a sign at the water.'}</div>`;
  if (p.needs) h += `<div class="warnbox" style="margin:12px 16px 0"><b>Needs:</b> ${esc(p.needs)}. Walk-In Access is private land opened by the owner, and each property can set its own dates and rules.</div>`;
  if (p.src === 'property' && typeof acFor === 'function') {
    const ac = acFor('dwr:' + String(p.id).slice(1));
    if (ac) h += acBlock(ac);
  }
  if (!FLINKED) h += fStale(now) + `<div class="warnbox fbad" style="margin:12px 16px 0"><b>The app has not matched this place to its rules,</b> because the places and the rules on this phone are from different builds. That does not mean the statewide rules apply. Look the water up by name under By water.</div>`;
  else if (rs.length) rs.forEach((res, i) => { h += fEntryHtml(res, now, { name: p.n.split(',')[0], counties: [p.c], kind: fPlaceKind(p), why: p.why || '', bare: i > 0 }); });
  else if (FLINKED) {
    const mine = fUnreadFor(p.n.split(',')[0], [p.c]);
    h += fStale(now, mine);
    mine.forEach(x => {
      h += `<div class="warnbox fbad" style="margin:12px 16px 0"><b>UDWR has posted a change that names this water and is not built into the app.</b>
        ${x.text.map(t => t[0] === 'li' ? '<br>&bull; ' + esc(t[1]) : '<br>' + esc(t[1])).join('')}
        <br><a href="${esc(x.url)}" target="_blank" rel="noopener">The signed notice</a></div>`;
    });
    h += `<div class="warnbox" style="margin:12px 16px 0"><b>The app could not match this place to a guidebook entry by name.</b>
      That does not mean statewide rules apply: UDWR's layers and the guidebook do not always spell a water the same way, and a rule can cover a water without naming it.
      Check the related entries and the county list below before you keep a fish.</div>`;
  }
  if (p.rel && p.rel.length) h += `<div class="sec-title" style="padding:0 16px">Related entries in the guidebook</div><p class="fine" style="padding:6px 16px 0">Similar names in the same county. Each may or may not cover the water you are on; read where it applies.</p>
    <div class="fcounty">${p.rel.map(r => `<button class="chip" data-fw="${esc(r)}">${esc((FW[r] || FCOM[r] || {}).name || r)}</button>`).join('')}</div>`;
  if (!rs.length && FLINKED) {
    const G = fGroupsHtml(fGroupsFor(p.n.split(',')[0], [p.c], fPlaceKind(p), p.rel || []), p.n.split(',')[0], now);
    h += fKokaneeNow(now) + `<div class="sec-title" style="padding:0 16px">Statewide limits</div>
      <p class="fine" style="padding:6px 16px 0">These are the limits <b>if</b> no entry covers this water. The app found none by this name; it cannot rule one out.</p>` + fStatewideHtml(null, G.rows) + G.h + fSpearHtml(fSpearFor(null, p.n.split(',')[0], [p.c]), null, '');
  }
  h += fCountyList(p.c, (p.w || []).concat(p.rel || []));
  let f = '';
  if (p.sp && p.sp.length) f += `<dt>Fish UDWR lists here</dt><dd>${p.sp.map(s => esc(s[0]) + (s[1] !== 'L' ? ' <i>(' + F_ABUND[s[1]] + ')</i>' : '')).join(', ')}</dd>`;
  if (p.st && p.st.length) f += `<dt>Last stocked</dt><dd>${p.st.map(s => esc(fWhen(fDay(String(s[0])))) + ': ' + esc(num(Number(s[2])).toLocaleString()) + ' ' + esc(String(s[1]).toLowerCase()) + (num(Number(s[3])) ? ', about ' + esc(num(Number(s[3])).toFixed(0)) + ' in.' : '')).join('<br>')}</dd>`;
  (p.prop || []).forEach(x => { f += `<dt>UDWR property here</dt><dd>${esc(x.n)}${x.pt ? ' &middot; ' + esc(x.pt) : ''}${x.needs ? '<br>Needs: ' + esc(x.needs) : ''}${x.restr ? '<br>' + esc(x.restr) : ''}${x.closure ? '<br>Closure: ' + esc(x.closure) : ''}</dd>`; });
  if (p.restr) f += `<dt>On this property</dt><dd>${esc(p.restr)}</dd>`;
  if (p.closure) f += `<dt>Property closure</dt><dd>${esc(p.closure)}</dd>`;
  if (num(p.snap) > 0.5) f += `<dt>Drive time *</dt><dd>The road the router knows ends about ${esc(num(p.snap).toFixed(1))} miles from this point. The minutes shown get you to the end of that road, not to the water.</dd>`;
  f += `<dt>Position</dt><dd>${p.src === 'property' ? 'The middle of the property boundary, not a parking area.' : p.src === 'registry' ? 'The middle of the water, from UDWR\'s lake registry (listed there as ' + esc(p.as || '') + ').' : 'UDWR\'s point for this water.'} ${p.k === 'stream' ? 'A river has one point here and many miles of bank.' : ''}</dd>`;
  f += `<div id="wx" style="display:contents"><dt>Forecast</dt><dd>Loading&hellip;</dd></div>`;
  h += `<dl class="f">${f}</dl>` + F_FOOT();
  return h;
}
function sheetFishWater(id) {
  const now = fNow(), res = fResolve(id, now, null);
  if (!res) return '';
  const e = FW[id] || FCOM[id], pl = (FBYW[id] || []).concat(FTWIN[id] ? (FBYW[FTWIN[id]] || []) : []).concat(res.via ? (FBYW[res.target.id] || []) : []).filter((x, i, a) => a.indexOf(x) === i);
  let h = `<h3>${esc(res.name)}</h3><p class="where">${esc(res.counties.join(', '))} ${res.counties.length > 1 ? 'counties' : 'County'}${e.br ? ' &middot; Blue Ribbon fishery' : ''}${e.group ? ' &middot; a rule for a group of waters' : ''}</p>`;
  if (e.group) h += `<div class="warnbox" style="margin:12px 16px 0"><b>This rule covers more than one water.</b> The guidebook describes which; it does not list every one by name. If you are on a stream or lake that fits the description, it applies to you.</div>`;
  h += fEntryHtml(res, now);
  if (pl.length) h += `<div class="sec-title" style="padding:0 16px">Places on this water</div><div class="card" style="margin:8px 16px 0">${pl.slice(0, 12).map(p => fPlaceRow(p, now)).join('')}</div>`;
  else if (((FP || {}).no_place || {})[id]) h += `<p class="fine" style="padding:10px 16px 0">No position for this water: ${esc(FP.no_place[id])}</p>`;
  return h + F_FOOT();
}

/* -------------------------------------------------------------- finder ---- */
/* [key, label, what it sounds like, what UDWR calls it, statewide row].
   The first match wins, so the narrow name is tested before the wide one that
   contains it: "tiger trout" before "trout", "striped bass" before "bass". */
const F_FISH = [
  ['tigertrout', 'Tiger trout', /\btiger\s*trout\b/, /tiger trout/i, 'trout'],
  ['tigermuskie', 'Tiger muskie', /\b(tiger\s*)?musk(ie|y|ies|ellunge)\b/, /tiger muskie/i, 'tigermuskie'],
  ['laketrout', 'Lake trout', /\b(lake\s*trout|mackinaws?|lakers?)\b/, /lake trout/i, 'trout'],
  ['brook', 'Brook trout', /\b(brook\s*trout|brookies?)\b/, /brook trout/i, 'trout'],
  ['brown', 'Brown trout', /\b(brown\s*trout|browns)\b/, /brown trout/i, 'trout'],
  ['rainbow', 'Rainbow trout', /\b(rainbow\s*trout|rainbows?)\b/, /rainbow trout/i, 'trout'],
  ['cutthroat', 'Cutthroat trout', /\b(cutthroat\s*trout|cutthroats?|cutts?)\b/, /cutthroat/i, 'trout'],
  ['golden', 'Golden trout', /\bgolden\s*trout\b/, /golden trout/i, 'trout'],
  ['splake', 'Splake', /\bsplake\b/, /splake/i, 'trout'],
  ['kokanee', 'Kokanee salmon', /\b(kokanee|salmon)\b/, /kokanee/i, 'trout'],
  ['grayling', 'Arctic grayling', /\bgrayling\b/, /grayling/i, 'trout'],
  ['trout', 'Trout', /\btrout\b/, /trout|splake|kokanee|grayling/i, 'trout'],
  ['whitefish', 'Whitefish', /\bwhitefish\b/, /whitefish/i, 'whitefish'],
  ['striper', 'Striped bass', /\b(striped\s*bass|stripers?)\b/, /striped bass/i, 'striper'],
  ['whitebass', 'White bass', /\bwhite\s*bass\b/, /white bass/i, 'whitebass'],
  ['smallmouth', 'Smallmouth bass', /\b(smallmouth(\s*bass)?|smallies?)\b/, /smallmouth/i, 'bass'],
  ['largemouth', 'Largemouth bass', /\b(largemouth(\s*bass)?|bucketmouths?)\b/, /largemouth/i, 'bass'],
  ['bass', 'Bass', /\bbass\b/, /largemouth|smallmouth/i, 'bass'],
  ['wiper', 'Wiper', /\bwipers?\b/, /wiper/i, 'wiper'],
  ['walleye', 'Walleye', /\bwalleyes?\b/, /walleye/i, 'walleye'],
  ['pike', 'Northern pike', /\b(northern\s*pike|pike)\b/, /northern pike/i, 'pike'],
  ['sacperch', 'Sacramento perch', /\bsacramento\s*perch\b/, /sacramento perch/i, 'sacperch'],
  ['perch', 'Yellow perch', /\b(yellow\s*perch|perch)\b/, /yellow perch/i, 'perch'],
  ['crappie', 'Crappie', /\bcrappies?\b/, /crappie/i, 'crappie'],
  ['bluegill', 'Bluegill and sunfish', /\b(bluegills?|sunfish|bream)\b/, /bluegill|sunfish|pumpkinseed/i, 'bluegill'],
  ['bullhead', 'Bullhead', /\bbullheads?\b/, /bullhead/i, 'bullhead'],
  ['catfish', 'Channel catfish', /\b(channel\s*cats?(fish)?|catfish)\b/, /channel catfish/i, 'catfish'],
  ['burbot', 'Burbot', /\bburbot\b/, /burbot/i, 'burbot'],
  ['cisco', 'Bonneville cisco', /\bcisco\b/, /cisco/i, 'cisco'],
  ['roundtail', 'Roundtail chub', /\broundtail(\s*chubs?)?\b/, /roundtail/i, 'roundtail'],
  ['crayfish', 'Crayfish', /\b(crayfish|crawdads?|crawfish)\b/, /crayfish/i, 'crayfish'],
  ['carp', 'Common carp', /\bcarp\b/, /carp/i, 'nongame']
];
/* Fish the guidebook says must be let go alive (p. 16). Suckers and chubs are NOT in
   the list above on purpose: most are nongame fish with no limit, some are protected,
   and a sentence seldom says which. So a sentence that names one is never answered
   with a limit. It is answered with the guidebook's list. */
function fProtected(rest) {
  const pr = FR && FR.statewide.rules.find(r => r.id === 'protected');
  if (!pr) return null;
  for (const n of (pr.items || []).slice().sort((a, b) => b.length - a.length)) {
    const k = fW(n).trimEnd();
    for (const tail of ['s ', ' ']) if (rest.indexOf(k + tail) >= 0) return { name: n, sure: true, rest: rest.replace(k + tail, ' ') };
  }
  const m = /\b(suckers?|chubs?|pikeminnows?|squawfish|woundfins?|bonytails?)\b/.exec(rest);
  return m ? { name: m[1], sure: false, rest: rest.replace(m[0], ' ') } : null;
}
const F_FISH_WORD = /\b(fish|fishing|fished|fishes|fishery|angl\w+|fly\s*fish\w*|ice\s*fish\w*|spear\s*fish\w*|cast(ing)?)\b/;
const F_HUNT_WORD = /\b(hunt\w*|shoot\w*|tags?|draw|rifle|archery|muzz\w*|decoys?)\b/;
/* Places whose names hold a fishing word or a fish, and are not about fishing. */
const F_FISH_NOISE = /\b(fish springs|fish haven|browns park|browns hole)\b/g;
/* Does the sentence name something to hunt? The hunt finder's own lists decide. */
function fGame(rest) {
  if (typeof F_SPECIES === 'undefined') return false;
  const st = typeof F_PLACE_NOISE !== 'undefined' ? rest.replace(F_PLACE_NOISE, ' ') : rest;
  if (typeof F_BIRD_GAPS !== 'undefined' && F_BIRD_GAPS.some(g => g[1].test(st))) return true;
  if (typeof F_BIRDS !== 'undefined' && F_BIRDS.some(b => b[2].test(st))) return true;
  return F_SPECIES.some(x => x[1].test(st));
}
/* Does an animal's name run across the edge of this stretch of the sentence? In
   "tushar mountain goat" the water's short name "tushar mountain" takes half of
   "mountain goat", so it is not the water that was meant. In "is duck fork open"
   the duck is wholly inside "duck fork", and the water was. */
function fSplitsGame(t, needle) {
  if (typeof F_SPECIES === 'undefined') return false;
  const a = t.indexOf(' ' + needle + ' ') + 1, b = a + needle.length;
  if (a < 1) return false;
  const pats = F_SPECIES.map(x => x[1]).concat(typeof F_BIRDS !== 'undefined' ? F_BIRDS.map(x => x[2]) : []);
  return pats.some(re => { const m = new RegExp(re.source, 'g'); let x; while ((x = m.exec(t))) { const s0 = x.index, e0 = s0 + x[0].length; if (s0 < b && e0 > a && (s0 < a || e0 > b)) return true; if (!x[0].length) m.lastIndex++; } return false; });
}
const fW = s => ' ' + String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
const F_COUNTIES = ['Beaver', 'Box Elder', 'Cache', 'Carbon', 'Daggett', 'Davis', 'Duchesne', 'Emery', 'Garfield', 'Grand', 'Iron', 'Juab', 'Kane', 'Millard', 'Morgan', 'Piute', 'Rich', 'Salt Lake', 'San Juan', 'Sanpete', 'Sevier', 'Summit', 'Tooele', 'Uintah', 'Utah', 'Wasatch', 'Washington', 'Wayne', 'Weber'];
/* Every water the app can name, longest first, so "provo river delta" is tried
   before "provo river". Words shared with an animal ("Sheep Creek", "Quail Creek")
   are why the water is looked for before the species is. */
let fNames = null, fShort = null;
const F_KIND = /\s+(reservoirs?|lakes?|ponds?|river|creek|stream|tributar(y|ies)|inflow|inlet|and its tributaries|angler access|wma|walk in access|conservation easement|state park|community fishery)\s*$/;
/* Words that are a water's short name and also something else the app answers
   for: an animal, a county, a town, a colour, one of Pete's own words for a home.
   A short name on this list is never matched; the full name still is. */
const F_NOT_SHORT = /^(bear|beaver|deer|duck|elk|moose|sheep|quail|swan|otter|pelican|goose|turkey|fish|trout|salmon|pine|spring|willow|cottonwood|clear|dry|lost|big|little|long|deep|blue|green|red|white|east|west|north|south|upper|lower|lake|mill|mud|sand|rock|salt|bull|mountain|boulder|fishlake|heber|torrey|home|cabin|utah|wasatch|summit|weber|cache|carbon|davis|duchesne|emery|garfield|grand|iron|juab|kane|millard|morgan|piute|rich|sanpete|sevier|tooele|uintah|washington|wayne|daggett|provo|ogden|logan|price|monroe|huntington|fairview|ferron|kolob|navajo|manti|uinta|uintas)$/;
function fWaterNames() {
  if (fNames) return fNames;
  const seen = {}, out = [], sseen = {}, sout = [];
  const put = (n, ref) => {
    const k = fW(n.replace(/\([^)]*\)/g, ' '));
    if (k.trim().length < 5) return;
    (seen[k] = seen[k] || (out.push([k, []]), out[out.length - 1][1])).push(ref);
    /* Shorter ways of saying it: "deer creek" for Deer Creek Reservoir, "pineview"
       for Pineview Reservoir. One word is kept only if it is not also an animal, a
       county, a town or a colour. */
    let b = k.trim(), t;
    const keep = x => { if (x !== k.trim() && x.length >= 6 && !F_NOT_SHORT.test(x) && (sseen[x] = sseen[x] || (sout.push([' ' + x + ' ', []]), sout[sout.length - 1][1])).indexOf(ref) < 0) sseen[x].push(ref); };
    while ((t = b.replace(F_KIND, '')) !== b && t) { b = t; if (b.indexOf(' ') > 0) keep(b); }
    keep(b);
  };
  FR.waters.forEach(w => put(w.name, { w: w.id }));
  FR.community.members.forEach(m => { put(m.name, { w: 'community:' + m.id }); if (m.also) put(m.also, { w: 'community:' + m.id }); });
  ((FP && FP.places) || []).forEach(p => {
    const part = p.n.split(',').map(x => x.trim());
    put(part[0], { p: p.id });
    /* "Provo River, Middle, from ..." is "the middle Provo" to everyone who fishes it. */
    if (part[1] && /^(lower|middle|upper)$/i.test(part[1])) put(part[1] + ' ' + part[0], { p: p.id });
  });
  fNames = out.sort((a, b) => b[0].length - a[0].length);
  fShort = sout.sort((a, b) => b[0].length - a[0].length);
  return fNames;
}
/* The water a sentence names, if any, and the sentence with that name taken out.
   Full names first. Then, if asked ('two'), short names of two words or more
   ("duck fork", "deer creek"), which are as good as a name. A one-word short name
   ("strawberry", "pineview") only when short is true: the sentence is already known
   to be about fishing. */
function fishWaterIn(text, short) {
  if (!FR) return null;
  const t = fW(text);
  for (const [needle, refs] of fWaterNames()) if (t.indexOf(needle) >= 0) return { needle: needle.trim(), refs, rest: t.replace(needle, ' ') };
  if (short) for (const [needle, refs] of fShort) {
    if (short === 'two' && needle.trim().indexOf(' ') < 0) continue;
    if (t.indexOf(needle) >= 0 && fSplitsGame(t, needle.trim())) continue;
    if (t.indexOf(needle) >= 0) return { needle: needle.trim(), refs, rest: t.replace(needle, ' '), short: true };
  }
  return null;
}
/* "in carbon county", "san juan co": the county, and the sentence without it. */
function fCountyIn(t) {
  for (const n of F_COUNTIES.slice().sort((a, b) => b.length - a.length)) {
    const k = fW(n).trimEnd();
    for (const tail of [' county ', ' co ']) if (t.indexOf(k + tail) >= 0) return { county: n, phrase: (k + tail).trim(), rest: t.replace(k + tail, ' ') };
  }
  return null;
}
const F_WATER_WORD = /^(lake|lakes|reservoir|reservoirs|river|creek|pond|ponds|fork|bay|slough|canal|springs?|dam)$/;
/* Is this sentence about fishing, and what does it ask? Returns null when it is
   not, so the hunt finder can have it. */
const F_ASKS = /\b(rules?|limits?|regs?|regulations?|open|closed|closures?)\b/;
function fishParse(text, always) {
  let t = fW(text);
  /* A county said as a county is a county, even when a water carries its name
     ("San Juan River", "Carbon County Community Fishery"). The water still wins
     when its whole name is there. */
  /* A fish the guidebook protects is looked for first and taken out of the sentence:
     "virgin river chub" is the chub, not the Virgin River. */
  let prot = FR ? fProtected(t) : null;
  if (prot && !prot.sure && /\broundtail\b/.test(t)) prot = null;             // "roundtail chub" has a row of its own
  if (prot) t = prot.rest;
  const full = FR ? fishWaterIn(t, false) : null, co = fCountyIn(t);
  if (co && !(full && (' ' + full.needle + ' ').indexOf(' ' + co.phrase + ' ') >= 0 && full.needle !== co.phrase)) t = co.rest;
  let hit = FR ? fishWaterIn(t, 'two') : null, rest = (hit ? hit.rest : t).replace(F_FISH_NOISE, ' ');
  let sp = null;
  for (const f of F_FISH) if (f[2].test(rest)) { sp = f; break; }
  if (prot) sp = null;
  const says = F_FISH_WORD.test(rest) || !!prot, hunts = F_HUNT_WORD.test(rest), asks = F_ASKS.test(rest), game = fGame(rest);
  /* Whose sentence is it? In order:
       a fishing word outside any water's name   -> fishing  ("a permit to fish Deseret Reservoir")
       a hunting word                            -> hunting  ("deer hunting in Browns Park")
       a fish by name                            -> fishing  ("bass at Quail Creek Reservoir")
       something to hunt by name                 -> hunting  ("is deer season open near Fish Lake")
       a water by its full name and a question   -> fishing  ("Strawberry Reservoir rules")
     Anything else is left to the hunt finder. */
  let short = null;
  if (!hit && FR && asks && !hunts && !game && !sp && !says) short = fishWaterIn(t, true);   // "is pineview open"
  const mine = always || says || (!hunts && (sp || (!game && (hit || short) && asks)));
  if (!mine) return null;
  /* The rules are still loading. Say so, and read the sentence again when they land. */
  if (!FR) return { text, pending: true, sp, water: null, place: null, county: null };
  /* A short name is only tried once the sentence is known to be about fishing, so
     that "strawberry" in a hunting sentence is left alone. */
  if (!hit) { hit = fishWaterIn(t, true); if (hit) rest = hit.rest.replace(F_FISH_NOISE, ' '); }
  const water = hit ? { needle: hit.needle, refs: hit.refs } : null;
  const q = { text, sp, water, place: null, county: null };
  if (prot) q.protected = { name: prot.name, sure: prot.sure };
  let left = rest;
  for (const h of (DB.config.homes || [])) {
    const a = (h.aliases || []).find(x => t.indexOf(fW(x)) >= 0);
    if (a) { q.place = { kind: 'home', id: h.id, label: h.label, lat: h.lat, lon: h.lon }; left = left.replace(fW(a), ' '); break; }
  }
  if (!q.place && /\b(here|where i am|my location|gps|right now|near me|nearby|closest)\b/.test(t)) q.place = { kind: 'gps' };
  if (co && t === co.rest) q.county = co.county;
  /* Words that look like the name of a water and matched nothing. Said out loud, so
     that a list of trout places is not taken for an answer about "Trial Lake". */
  if (!water) {
    const w = left.replace(F_FISH_NOISE, ' ').trim().split(' ').filter(Boolean);
    const k = w.findIndex(x => F_WATER_WORD.test(x));
    if (k > 0) {
      let a = k - 1;
      while (a > 0 && k - a < 3 && !F_STOP.test(w[a - 1]) && !F_FISH.some(f => f[2].test(' ' + w[a - 1] + ' '))) a--;
      const name = w.slice(a, k + 1).filter(x => !F_STOP.test(x) || F_WATER_WORD.test(x));
      if (name.length > 1 && !F_STOP.test(name[0]) && !F_FISH.some(f => f[2].test(' ' + name[0] + ' '))) q.unknown = name.join(' ');
    }
  }
  return q;
}
function fishMatches(q) {
  const now = fNow();
  let list = (FP.places || []).slice();
  if (q.sp) list = list.filter(p => (p.sp || []).some(s => q.sp[3].test(s[0]) && s[1] !== 'X'));
  if (q.county) list = list.filter(p => p.c === q.county);
  const key = p => (q.place && q.place.lat != null && q.place.kind !== 'home') ? miles(q.place.lat, q.place.lon, p.lat, p.lon) * 1.4 : fDrive(p, q.place && q.place.kind === 'home' ? q.place.id : home).mins;
  return list.sort((a, b) => key(a) - key(b));
}
function fishAnswer(q) {
  const now = fNow();
  let h = '';
  if (FR && q.protected) {
    const pr = FR.statewide.rules.find(r => r.id === 'protected');
    h += `<div class="warnbox fbad" style="margin-top:12px"><b>${q.protected.sure ? esc(q.protected.name) + ' is on the guidebook\'s list of fish that must be let go.' : 'The guidebook protects some of the fish that word covers, and the app cannot tell which you mean. So it gives no limit.'}</b>
      ${esc(pr.text)}<ul>${(pr.items || []).map(i => `<li>${esc(i)}</li>`).join('')}</ul><span class="fdates">guidebook p. ${esc(pr.page)}</span>
      Some waters also require every sucker to be released; open the water for its own rules.</div>`;
    if (!q.water) return h;
  }
  if (q.pending || !FR) return `<p class="empty">${fishState === 'failed' ? 'The fishing rules are not on this phone yet. Open this once with a signal.' : 'Loading the fishing rules&hellip;'}</p>`;
  if (q.water) {
    const ws = q.water.refs.filter(r => r.w).map(r => r.w), ps = q.water.refs.filter(r => r.p).map(r => FPL[r.p]).filter(Boolean);
    const ids = fOnce(ws.concat(ps.reduce((a, p) => a.concat(p.w || []), [])));
    const cs = ids.map(id => (fResolve(id, now, null) || { counties: [] }).counties.join(','));
    h += `<div class="sec-title">${esc(q.water.needle)} &middot; ${ids.length ? ids.length + ' guidebook entr' + (ids.length === 1 ? 'y' : 'ies') : 'no entry of its own'}</div>`;
    if (ids.length > 1) h += `<p class="fine" style="padding-left:2px">More than one entry carries that name. ${cs.some((c, i) => cs.indexOf(c) !== i) ? 'Open each one: they are different waters, or different parts of one.' : 'The county tells them apart.'}</p>`;
    if (ids.length) h += `<div class="card">${ids.map(id => { const res = fResolve(id, now, null), s = fSummary(res), am = res.changes.some(c => c.st.k === 'on');
      return `<button class="row" data-fw="${esc(id)}" style="--g:var(--fish)"><span class="pill"></span><span><span class="t">${esc(res.name)}</span><span class="s">${esc(res.counties.join(', '))} Co.</span><span class="s fchipline">${fChipHtml(fChips(s, am, res).concat(s.mixed ? [['shut', 'Differs by stretch']] : []))}</span></span><span class="v">&rsaquo;</span></button>`; }).join('')}</div>`;
    if (ps.length) h += `<div class="sec-title">Places</div><div class="card">${ps.slice(0, 12).map(p => fPlaceRow(p, now, q.place)).join('')}</div>`;
    if (!ids.length && ps.length) h += `<p class="fine" style="padding-left:2px">No guidebook entry carries that exact name. That is not the same as the statewide rules applying. Open the place to see related entries, group rules and every water with its own rules in that county.</p>`;
    return h;
  }
  if (q.unknown) h += `<div class="warnbox" style="margin-top:12px"><b>The app does not know a water called "${esc(q.unknown)}".</b> What follows is not an answer about that water. It may be listed under another name or covered by a rule for a group of waters; having no entry by that name is not the same as the statewide rules applying. Try By water, or the county.</div>`;
  if (FP.missing) return h + `<p class="empty">The list of fishing places is not on this phone yet, so the app cannot say what is near. Rules can still be looked up by water on the Fish tab.</p>`;
  if (q.place && q.place.kind === 'gps' && q.place.lat == null) return '<p class="empty">Getting a GPS fix&hellip;</p>';
  const list = fishMatches(q), from = q.place ? (q.place.label || 'where you are') : hlabel();
  h += `<div class="sec-title">${esc(q.sp ? q.sp[1] : 'Fishing')}${q.county ? ' &middot; ' + esc(q.county) + ' County' : ''} &middot; ${list.length} place${list.length === 1 ? '' : 's'} &middot; from ${esc(from)}</div>`;
  if (q.sp) {
    const row = FROW[q.sp[4]];
    if (row) h += `<div class="card"><div class="row" style="--g:var(--fish)"><span class="pill"></span><span><span class="t">Statewide limit: ${esc(row.name)}</span><span class="s">${esc(row.label)}</span></span><span class="v">${esc(row.limit)}</span></div></div>`;
    if (q.sp[0] === 'kokanee') h += fKokaneeBox(now);
    h += `<p class="fine" style="padding-left:2px">Listed by UDWR as holding ${esc(q.sp[1].toLowerCase())}. The statewide limit is the limit only where no rule of the water's own changes it. The chips say what the app found for each place; open it before you keep a fish.</p>`;
  }
  h += list.length ? `<div class="card">${list.slice(0, fish.show).map(p => fPlaceRow(p, now, q.place)).join('')}</div>` : `<p class="empty">UDWR lists no place with ${esc(q.sp ? q.sp[1].toLowerCase() : 'fish')}${q.county ? ' in ' + esc(q.county) + ' County' : ''}.</p>`;
  if (list.length > fish.show) h += `<div class="acts" style="padding:10px 0 0"><button class="btn ghost" data-fmore="1">Show ${Math.min(20, list.length - fish.show)} more</button></div>`;
  return h;
}
/* The statewide kokanee closure applies at every water, including those with a
   trout rule of their own, so while it is in force it is printed on every sheet. */
function fKokaneeNow(now) {
  const k = FR.statewide.rules.find(r => r.id === 'kokanee');
  if (!k || !k.fx || !k.fx[0] || !k.fx[0].w || !fEdition(now).current || !fAnyOn(k.fx[0].w, now)) return '';
  return `<div class="warnbox" style="margin:12px 16px 0"><b>Statewide, in force today: kokanee salmon may not be kept.</b> ${esc(k.text)} <span class="fdates">${esc(fSpansText(k.fx[0].w))} &middot; guidebook p. ${esc(k.page)}</span></div>`;
}
function fKokaneeBox(now) {
  const k = FR.statewide.rules.find(r => r.id === 'kokanee');
  if (!k || !k.fx || !k.fx[0] || !k.fx[0].w) return '';
  const on = fEdition(now).current && fAnyOn(k.fx[0].w, now);
  return `<div class="warnbox" style="margin-top:12px"><b>${on ? 'Kokanee may not be kept anywhere in Utah today.' : 'Kokanee: statewide fall closure.'}</b> ${esc(k.text)} <span class="fdates">${esc(fSpansText(k.fx[0].w))}</span></div>`;
}

/* --------------------------------------------------------------- views ---- */
function fBanners(now) {
  const n = fNotices();
  let h = fStale(now, n.unread, false);
  n.unread.forEach(x => {
    h += `<div class="warnbox fbad"><b>New from UDWR, not yet built into the rules below: ${esc(x.title)}.</b>
      ${x.text.map(t => t[0] === 'li' ? '<br>&bull; ' + esc(t[1]) : '<br>' + esc(t[1])).join('')}
      <br><a href="${esc(x.url)}" target="_blank" rel="noopener">The signed notice</a> &middot; first seen ${esc(x.first_seen || '')}</div>`;
  });
  return h;
}
function fChangesCard(now) {
  const all = (FR.amendments || []).map(a => ({ a, st: fAmendState(a, now) })), on = all.filter(x => x.st.k === 'on').sort((x, y) => x.st.left - y.st.left);
  if (!all.length) return '';
  let h = `<div class="sec-title">Emergency changes in force &middot; ${on.length} of ${all.length} posted for ${esc(FR._edition.year)}</div><div class="card">`;
  h += on.map(x => `<button class="row" data-fw="${esc(x.a.community ? 'community:' + x.a.community : x.a.water)}" style="--g:var(--crit)"><span class="pill"></span>
    <span><span class="t">${esc(x.a.name)}</span><span class="s">${esc(x.a.county)} Co. &middot; ${esc(x.a.rules.map(r => r.text).join('; '))}</span></span>
    <span class="v"><span class="state ${x.st.left <= 7 ? 'crit' : 'soon'}">${esc(x.st.left === 0 ? 'today' : x.st.left + 'd')}</span><small>${esc(fWhen(fDay(x.a.last_day)).replace(/, \d{4}/, ''))}</small></span></button>`).join('') || '<p class="empty">None in force today.</p>';
  const done = all.filter(x => x.st.k === 'ended'), held = all.filter(x => x.st.k === 'held');
  h += `</div>`;
  if (held.length) h += `<p class="fine" style="padding-left:2px"><b>Set aside</b> because UDWR has removed or reworded the notice: ${held.map(x => esc(x.a.name)).join(', ')}. The guidebook rule is shown for ${held.length === 1 ? 'that water' : 'those waters'}.</p>`;
  if (done.length) h += `<p class="fine" style="padding-left:2px">Ended and back to the guidebook rule: ${done.map(x => esc(x.a.name)).join(', ')}.</p>`;
  return h;
}
function fInForce(now) {
  let h = fKokaneeBox(now);
  return h + fChangesCard(now);
}
function cardFish() {
  if (!FR) { fishLoad(); return ''; }
  const now = fNow(), ed = fEdition(now);
  if (!ed.current) return `<div class="sec-title">Fishing</div><div class="card"><button class="row" data-tab="fish" style="--g:var(--crit)"><span class="pill"></span><span><span class="t">The ${esc(ed.year)} fishing rules are out of date</span><span class="s">Open Fish for details</span></span><span class="v">&rsaquo;</span></button></div>`;
  const on = (FR.amendments || []).map(a => ({ a, st: fAmendState(a, now) })).filter(x => x.st.k === 'on');
  const soon = on.filter(x => x.st.left <= 7), n = fNotices(), k = FR.statewide.rules.find(r => r.id === 'kokanee');
  const kok = k && fAnyOn(k.fx[0].w, now);
  const alert = n.unread.length || n.book || n.gone.length || n.changed.length || n.list, blind = n.failed || n.old;
  return `<div class="sec-title">Fishing</div><div class="card"><button class="row" data-tab="fish" style="--g:${alert || blind ? 'var(--crit)' : 'var(--fish)'}"><span class="pill"></span>
    <span><span class="t">${alert ? 'UDWR has posted something new' : blind ? 'UDWR\'s list of changes has not been read lately' : on.length + ' emergency change' + (on.length === 1 ? '' : 's') + ' in force'}</span>
    <span class="s">${soon.length ? soon.length + ' end' + (soon.length === 1 ? 's' : '') + ' within a week (' + esc(soon.map(x => x.a.name.replace(/ (Reservoir|Park Pond)$/, '')).join(', ')) + ')' : 'None ending this week'}${kok ? ' &middot; kokanee may not be kept' : ''}</span></span>
    <span class="v">&rsaquo;</span></button></div>`;
}
function vFishNear(now) {
  let list = (FP.places || []).slice();
  if (fish.county) list = list.filter(p => p.c === fish.county);
  list.sort((a, b) => fDrive(a).mins - fDrive(b).mins);
  let h = `<div class="sec-title">Closest water from ${esc(hlabel())} &middot; ${list.length} places</div>
    <div class="card">${list.slice(0, fish.show).map(p => fPlaceRow(p, now)).join('')}</div>`;
  if (list.length > fish.show) h += `<div class="acts" style="padding:10px 0 0"><button class="btn ghost" data-fmore="1">Show 20 more</button></div>`;
  h += `<p class="fine" style="padding-left:2px">Minutes are road time from the middle of town. A star means the road stops short of the water. Miles, where shown, are a straight line. ${FLINKED ? '' : '<b>The places and the rules on this phone are from different builds, so no place is matched to its rules. Look each water up under By water.</b> '}The chips say what the app found for that water today. <b>No entry by this name</b> means the guidebook lists no water by that name in that county. It may still be covered by an entry under another name or by a rule for a group of waters, so open the place before you keep a fish. <b>Check group rule</b> means a rule for a group of waters in that county may cover it.</p>`;
  return h;
}
const F_STOP = /^(a|an|and|are|at|by|can|do|does|for|from|how|i|in|is|it|me|my|near|of|on|or|the|to|what|whats|where|which|with|you|open|opens|closed|close|closes|rules?|limits?|regs?|regulations?|fish|fishing|need|permit|license|licence|keep|many|much|any|there|today|now|this|that|season|county|co)$/;
const fTokens = q => fW(q).trim().split(' ').filter(x => x && !F_STOP.test(x));
function vFishRules(now) {
  const tk = fTokens(fish.q), has = hay => tk.every(x => fW(hay).indexOf(' ' + x) >= 0);
  const ws = FR.waters.filter(w => has(w.name + ' ' + fCounties(w).join(' ') + ' ' + (w.also || []).join(' ')));
  const cs = FR.community.members.filter(m => has(m.name + ' ' + (m.also || '') + ' ' + m.county + ' community'));
  if (tk.length && !ws.length && !cs.length) return `<div class="warnbox" style="margin-top:12px"><b>Nothing in the guidebook's list matched "${esc(fish.q.trim())}".</b>
    That is not the same as the statewide rules applying. The water may be listed under another name, or covered by an entry for a group of waters. Try one word of its name, or a county.</div>
    <div class="acts" style="padding:10px 0 0"><button class="btn ghost" data-fclear="1">Show every water</button></div>`;
  let h = `<div class="sec-title">Waters with their own rules &middot; ${ws.length} of ${FR.waters.length}</div><div class="card">`;
  h += ws.map(w => {
    const res = fResolve(w.id, now, null), s = fSummary(res), am = res.changes.some(c => c.st.k === 'on');
    const chips = fChips(s, am, res).concat(s.mixed ? [['shut', 'Differs by stretch']] : []);
    return `<button class="row" data-fw="${esc(w.id)}" style="--g:${s.closed ? 'var(--crit)' : 'var(--fish)'}"><span class="pill"></span>
      <span><span class="t">${esc(w.name)}</span><span class="s">${esc(fCounties(w).join(', '))} Co.${w.kind === 'pointer' ? ' &middot; see ' + esc((FW[w.see.water] || {}).name || '') : ''}${w.kind === 'notice' ? ' &middot; emergency change only' : ''}</span>
      <span class="s fchipline">${fChipHtml(chips)}</span></span><span class="v">p. ${esc(w.page || '--')}</span></button>`;
  }).join('') || '<p class="empty">None of these match. See the community waters below.</p>';
  h += `</div>`;
  if (cs.length) h += `<div class="sec-title">Community fishing waters &middot; ${cs.length} of ${FR.community.members.length}</div>
    <p class="fine" style="padding-left:2px">One set of rules covers all of them: ${esc(FR.community.rules[0].text)}</p>
    <div class="card">${cs.map(m => { const res = fResolve('community:' + m.id, now, null), sm = fSummary(res), am = res.changes.some(c => c.st.k === 'on');
      const chips = fChips(sm, am, res).filter(c => c[1] !== 'Own limits');
      return `<button class="row" data-fw="community:${esc(m.id)}" style="--g:${sm.closed ? 'var(--crit)' : 'var(--fish)'}"><span class="pill"></span><span><span class="t">${esc(m.name)}</span><span class="s">${esc(m.county)} Co.${m.also ? ' &middot; also called ' + esc(m.also) : ''}</span>${chips.length ? `<span class="s fchipline">${fChipHtml(chips)}</span>` : ''}</span><span class="v">p. ${esc(FR.community.page)}</span></button>`; }).join('')}</div>`;
  h += `<p class="fine" style="padding-left:2px"><b>A water that is not on this list is under the statewide rules</b>, in the guidebook's own words: "General rules apply to all of the waters NOT listed in this section." The catch is the name. Some entries cover streams they do not name one by one, so read the tributary and group entries for your county.</p>`;
  return h;
}
function vFishState(now) {
  let h = `<div class="sec-title">Statewide daily limits &middot; guidebook p. ${esc(FR.statewide.page)}</div><div class="card">`;
  h += FR.statewide.limits.map(l => `<div class="row" style="--g:var(--fish)"><span class="pill"></span><span><span class="t">${esc(l.name)}</span>${l.label !== l.name ? `<span class="s">${esc(l.label)}</span>` : ''}</span><span class="v dv">${esc(l.limit)}</span></div>`).join('');
  h += `</div><p class="fine" style="padding-left:2px">These apply to every water that has no rule of its own for that fish. UDWR's words: "On waters that have a specific rule, that rule takes precedence over the general rules."</p>`;
  h += `<div class="sec-title">Rules that apply everywhere</div><div class="card"><div class="fgen">`;
  h += FR.statewide.rules.map(r => `<div class="frule"><span class="ftopic">${esc(r.head)}</span><span class="ftext">${esc(r.text)}${(r.items || []).length ? '<ul>' + r.items.map(i => `<li>${esc(i)}</li>`).join('') + '</ul>' : ''}<span class="fdates">p. ${esc(r.page)}</span></span></div>`).join('');
  h += `</div></div><p class="fine" style="padding-left:2px">A selection, word for word, each read against the page by an independent checker. The guidebook holds the rest: fish used as bait, setlines, bowfishing, dipnets, crayfish, trespass, waste, tagging, and which fish must be killed or released.</p>`;
  if ((FR.spear || {}).general) h += `<div class="sec-title">Underwater spearfishing</div><p class="fine" style="padding-left:2px">Only waters the guidebook lists, or an emergency change opens, are open to spearfishing for game fish. Each water's sheet says whether it is listed.</p><div style="margin:0 -16px">${fSpearGeneral(true)}</div>`;
  return h;
}
function vFish() {
  if (fishState === 'idle') fishLoad();
  if (!FR) return fishState === 'failed' ? `<p class="empty">The fishing rules are not on this phone yet. Open this once with a signal.</p><div class="acts" style="padding:10px 0 0"><button class="btn" data-fretry="1">Try again</button></div>` : '<p class="empty">Loading the fishing rules&hellip;</p>';
  if (!FP) FP = F_NOPLACES();
  const now = fNow();
  let h = fBanners(now);
  h += `<form id="fishform" style="margin-top:12px"><input class="search" id="fishq" placeholder="trout near the cabin, or a water by name" value="${esc(fish.q)}" autocomplete="off"></form>
    <div class="seg" style="margin-top:10px">${[['near', 'Near'], ['rules', 'By water'], ['state', 'Statewide'], ['now', 'In force']].map(m => `<button data-fmode="${m[0]}" aria-pressed="${fish.mode === m[0] && !fish.parsed}">${m[1]}</button>`).join('')}</div>`;
  if (fish.parsed) return h + `<div class="chipsrow"><button class="chip" data-fclear="1" aria-pressed="true">${esc(fish.q)} &times;</button></div>` + fishAnswer(fish.parsed) + F_FOOT();
  if (fish.mode === 'near') h += `<div class="chipsrow">${['trout', 'bass', 'walleye', 'catfish', 'perch', 'crappie', 'bluegill', 'wiper', 'kokanee'].map(k => { const f = F_FISH.find(x => x[0] === k); return `<button class="chip" data-fsp="${k}">${esc(f[1])}</button>`; }).join('')}</div>` + vFishNear(now);
  if (fish.mode === 'rules') h += vFishRules(now);
  if (fish.mode === 'state') h += vFishState(now);
  if (fish.mode === 'now') h += fInForce(now) + `<p class="fine" style="padding-left:2px">UDWR posts emergency changes as signed notices and does not fold them into the guidebook. The app reads the list every morning. ${FNT && FNT.last_ok ? 'Last read ' + esc(fWhen(new Date(FNT.last_ok))) + '.' : ''}</p>`;
  return h + F_FOOT();
}

/* -------------------------------------------------------------- events ---- */
function fishRun(text) {
  fish.q = text; fish.show = 12;
  const q = text.trim() ? fishParse(text, true) : null;   // anything typed on the Fish tab is about fishing
  /* Nothing in the sentence was recognised. The list of waters is searched for its
     words, and if that finds nothing the screen says so in as many words. */
  if (q && !q.water && !q.sp && !q.place && !q.county && !q.unknown && !q.protected) { fish.mode = 'rules'; fish.parsed = null; render(); return; }
  fish.parsed = q;
  if (q && q.place && q.place.kind === 'gps' && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(p => { q.place = { kind: 'gps', label: 'where I am', lat: p.coords.latitude, lon: p.coords.longitude }; render(); },
      () => { q.place = null; render(); }, { enableHighAccuracy: true, timeout: 15000 });
  }
  render();
}
document.addEventListener('submit', e => { if (e.target.id === 'fishform') { e.preventDefault(); fishRun($('fishq').value); } });
document.addEventListener('input', e => {
  if (e.target.id !== 'fishq' || fish.mode !== 'rules' || fish.parsed) return;
  fish.q = e.target.value; const s = e.target.selectionStart; render();
  const n = $('fishq'); if (n) { n.focus(); n.setSelectionRange(s, s); }
});
document.addEventListener('click', e => {
  const t = e.target.closest('[data-fp],[data-fw],[data-fmode],[data-fsp],[data-fclear],[data-fmore],[data-fretry]');
  if (!t) return;
  if (t.dataset.fretry) { fishLoad(true); render(); return; }
  if (!FR) return;
  if (t.dataset.fp) { const p = FPL[t.dataset.fp]; if (p) { openSheet(sheetFishPlace(p)); if (typeof loadWx === 'function') loadWx(p.lat, p.lon); } return; }
  if (t.dataset.fw) { openSheet(sheetFishWater(t.dataset.fw)); return; }
  if (t.dataset.fmode) { fish.mode = t.dataset.fmode; fish.parsed = null; fish.show = 12; if (fish.mode !== 'rules') fish.q = ''; try { localStorage.setItem('ha.fishmode', fish.mode); } catch (x) { /* private mode */ } render(); window.scrollTo(0, 0); return; }
  if (t.dataset.fsp) { const f = F_FISH.find(x => x[0] === t.dataset.fsp); fishRun(f[1].toLowerCase() + ' near ' + hlabel().toLowerCase()); return; }
  if (t.dataset.fclear) { fish.parsed = null; fish.q = ''; fish.show = 12; render(); return; }
  if (t.dataset.fmore) { fish.show += 20; render(); return; }
});
