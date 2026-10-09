const STATE = (() => {
  try { return localStorage.getItem('ha.state') || 'ut'; } catch (e) { return 'ut'; }
})();

/* The towns drive times are measured from. config.json lists twelve public anchor towns
   (DB.config.anchors). The hunter chooses up to three and may give each some words of
   their own; the choice lives in this phone's localStorage and goes nowhere else:
     ha.anchors  JSON list of { id, words }, the chosen towns in the hunter's order; the first is "home"
     ha.anchor   the id drive times are measured from; unset, or not chosen, means the first chosen
   This file loads before every other script so the screens, the finders and the Home towns
   page all read the choice one way. DB belongs to app.js and is only touched when one of
   these functions is called, never while this file loads. */
const ANCHOR_MAX = 3;
let anchorSel = [];        // ha.anchors as read: [{ id, words }], not yet checked against the data
let anchorPick = null;     // ha.anchor as read

/* A stored list made safe: bad shapes and repeated ids dropped, and words kept only when they are
   a list of non-empty trimmed strings. Unknown ids need the data, so anchorsChosen drops those. */
function anchorClean(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const e of list) {
    if (!e || typeof e.id !== 'string' || out.some(x => x.id === e.id)) continue;
    const ok = Array.isArray(e.words) && e.words.every(w => typeof w === 'string' && w !== '' && w === w.trim());
    out.push({ id: e.id, words: ok ? e.words.slice() : [] });
  }
  return out;
}

function anchorRead() {
  try { anchorSel = anchorClean(JSON.parse(localStorage.getItem('ha.anchors'))); } catch (e) { anchorSel = []; /* none, bad JSON or private mode */ }
  try { anchorPick = localStorage.getItem('ha.anchor'); } catch (e) { anchorPick = null; /* private mode */ }
}
const anchorPut = (key, val) => { try { val == null ? localStorage.removeItem(key) : localStorage.setItem(key, val); } catch (e) { /* private mode */ } };

/* v35 kept one chosen home in ha.home (nsl, heber or torrey). A phone that has it and no
   ha.anchors yet gets the three towns those stood for, with its old choice still measuring.
   This is the only place the old key is read, and it is left where it is. A phone without
   it writes nothing and starts on Salt Lake City alone. */
function anchorCarryOver() {
  try {
    if (localStorage.getItem('ha.anchors') != null) return;
    const old = localStorage.getItem('ha.home');
    if (old == null) return;
    localStorage.setItem('ha.anchors', JSON.stringify([{ id: 'slc' }, { id: 'heber' }, { id: 'torrey' }]));
    localStorage.setItem('ha.anchor', old === 'heber' || old === 'torrey' ? old : 'slc');
  } catch (e) { /* private mode */ }
}
anchorCarryOver();
anchorRead();

/* The twelve towns the data offers, and one of them by id. */
const anchorList = () => (DB.config && DB.config.anchors) || [];
const anchorById = id => anchorList().find(a => a.id === id) || null;

/* The chosen towns, in the hunter's order, as the data rows plus two lists: `words` is what
   the hunter typed for the town and `aliases` is what the finders listen for ("home" on the
   first town, then its words). Ids the data does not know are dropped, at most three are kept,
   and nothing left means Salt Lake City alone. The list is frozen and kept until the choice or
   the data changes, because the sorts call it for every place. */
let anchorMemo = null;
function anchorsChosen() {
  const rows = anchorList();
  if (anchorMemo && anchorMemo.sel === anchorSel && anchorMemo.rows === rows) return anchorMemo.out;
  const join = list => list.map(e => { const a = anchorById(e.id); return a && Object.assign({}, a, { words: e.words }); }).filter(Boolean).slice(0, ANCHOR_MAX);
  let out = join(anchorSel);
  if (!out.length) out = join([{ id: 'slc', words: [] }]);
  out = Object.freeze(out.map((a, i) => Object.assign(a, { aliases: (i === 0 ? ['home'] : []).concat(a.words) })));
  anchorMemo = { sel: anchorSel, rows, out };
  return out;
}

/* The town the app measures from: the one the header chip lights, else the first chosen. */
function anchorMeasure() {
  const c = anchorsChosen();
  return c.find(a => a.id === anchorPick) || c[0] || null;
}
const anchorId = () => { const a = anchorMeasure(); return a ? a.id : null; };
const anchorLabel = () => { const a = anchorMeasure(); return a ? a.label : 'home'; };

/* Tapping a header chip: change what is measured, never the order of the chosen towns. */
function anchorSetMeasure(id) {
  if (!anchorsChosen().some(a => a.id === id)) return;
  anchorPick = id;
  anchorPut('ha.anchor', id);
}

/* Choose the towns: a list of { id, words } in the order wanted. Anything the data does not
   know, repeats and a fourth town are dropped. A measuring town that is no longer chosen is
   forgotten, so choosing it again later does not quietly make it the measuring one. */
function anchorSetChosen(list) {
  anchorSel = anchorClean(list).filter(e => anchorById(e.id)).slice(0, ANCHOR_MAX);
  anchorPut('ha.anchors', JSON.stringify(anchorSel));
  if (anchorPick != null && !anchorSel.some(e => e.id === anchorPick)) { anchorPick = null; anchorPut('ha.anchor', null); }
}

/* The hunter's own words for one chosen town: a list of trimmed, non-empty strings. */
function anchorSetWords(id, words) {
  anchorSetChosen(anchorsChosen().map(a => ({ id: a.id, words: a.id === id ? words : a.words })));
}
