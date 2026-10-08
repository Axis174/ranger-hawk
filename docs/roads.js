/* Ranger Hawk - what the drive looks like between home and the hunt.

   UDOT publishes road cameras, weather stations, current road conditions and
   mountain pass status. This picks the ones that sit along the way to a place
   you tapped, in the order you would pass them, so you can see what you are
   driving into before you lose signal.

   What this is NOT: a route. There is no routing engine on the phone and no
   signal in the places this app is for, so the corridor is a straight line
   between the two points, widened to catch the road that actually connects
   them. In canyon country the road can leave that corridor - a camera missing
   from the list does not mean the road is clear. The list is a look ahead, not
   a survey.

   Camera LOCATIONS are cached with the rest of the data and work offline. The
   IMAGES are live and need a signal, which is exactly the thing you are about
   to lose, so check them before you leave the valley.

   Loaded after app.js; shares its globals ($, esc, miles, DB, home). */
'use strict';

let ROADS = null, roadsLoading = false;
const ROAD_KIND = {
  cameras: ['Camera', 'var(--accent)'],
  weather: ['Weather station', 'var(--brand)'],
  conditions: ['Road condition', 'var(--warn)'],
  passes: ['Mountain pass', 'var(--warn)']
};

function roadLoad(then) {
  if (ROADS || roadsLoading) { if (ROADS && then) then(); return; }
  roadsLoading = true;
  fetch('data/' + STATE + '/udot.json').then(r => r.json())
    .then(j => { ROADS = j && typeof j === 'object' ? j : { key: false }; })
    .catch(() => { ROADS = { key: false, note: 'Road data is not on this phone yet. Open this once with a signal.' }; })
    .finally(() => { roadsLoading = false; if (then) then(); });
}

/* Where a point falls relative to the segment A->B: t is how far along (0 at A,
   1 at B), off is how far to the side in miles. Longitude is squeezed by the
   cosine of the latitude so the two axes are the same size; over a few hundred
   miles of Utah that is close enough to measure an offset with. */
function roadProject(aLat, aLon, bLat, bLon, pLat, pLon) {
  const k = Math.cos((aLat + bLat) / 2 * Math.PI / 180), DEG = 69.0;
  const ax = aLon * k, ay = aLat, bx = bLon * k, by = bLat, px = pLon * k, py = pLat;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  const tc = Math.max(0, Math.min(1, t));
  const cx = ax + tc * dx, cy = ay + tc * dy;
  return { t, off: Math.hypot(px - cx, py - cy) * DEG };
}

/* A wider corridor on a longer drive, because a long drive bends more. Never
   narrower than 8 miles or the canyon roads fall out of it, never wider than
   25 or it stops meaning "on the way". */
const roadWidth = mi => Math.max(8, Math.min(25, mi * 0.15));

function roadCorridor(from, to, kinds) {
  if (!ROADS || !ROADS.key) return { items: [], mi: 0, width: 0 };
  const mi = miles(from.lat, from.lon, to.lat, to.lon), width = roadWidth(mi), out = [];
  for (const kind of kinds) {
    for (const it of (ROADS[kind] || [])) {
      const { t, off } = roadProject(from.lat, from.lon, to.lat, to.lon, it.lat, it.lon);
      if (off <= width && t >= -0.05 && t <= 1.05) out.push({ it, kind, t, off, at: Math.max(0, t) * mi });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return { items: out, mi, width };
}

function roadRow(r) {
  const [label, colour] = ROAD_KIND[r.kind] || ['', 'var(--muted)'];
  const where = [r.it.road, r.it.dir].filter(Boolean).join(' ');
  return `<div class="row" style="--g:${colour}"><span class="pill"></span>
    <span><span class="t">${esc(r.it.n || label)}</span>
    <span class="s">${esc(label)}${where ? ' &middot; ' + esc(where) : ''} &middot; ${r.off < 1 ? 'on the line' : r.off.toFixed(0) + ' mi to the side'}</span></span>
    <span class="v">${Math.round(r.at)}<small>mi in</small></span></div>`;
}

/* Camera stills, only when there is a signal to fetch them with. */
function roadShots(items) {
  const cams = items.filter(r => r.kind === 'cameras' && r.it.v && r.it.v.length).slice(0, 6);
  if (!cams.length) return '';
  if (!navigator.onLine) return `<p class="fine" style="padding-left:2px">${cams.length} camera${cams.length === 1 ? '' : 's'} on this stretch. The pictures need a signal - the app has their positions, not their images.</p>`;
  return `<div class="camgrid">${cams.map(r => `<button data-roadcam="${esc(r.it.v[0])}">
    <img loading="lazy" src="${esc(r.it.v[0])}" alt="${esc(r.it.n)}" onerror="this.closest('button').style.display='none'">
    <span>${Math.round(r.at)} mi &middot; ${esc((r.it.n || '').slice(0, 26))}</span></button>`).join('')}</div>`;
}

/* The slot sheetPoint leaves for us, filled once the data is in. This runs while
   the sheet is still being built as a string, so the fill has to wait a tick for
   that string to reach the DOM - on the second open the data is already cached
   and the callback would otherwise fire against a #roadbox that does not exist
   yet, leaving the section silently blank. */
function roadSlot(p) {
  setTimeout(() => roadLoad(() => roadFill(p)), 0);
  return `<div id="roadbox"></div>`;
}
function roadFill(p) {
  const el = $('roadbox');
  if (!el) return;
  const h = (DB.config.homes || []).find(x => x.id === home);
  if (!h) { el.innerHTML = ''; return; }
  if (!ROADS || !ROADS.key) {
    el.innerHTML = `<p class="fine" style="padding-left:2px"><b>Road cameras are not set up yet.</b>
      ${esc((ROADS && ROADS.note) || 'No road data has been pulled.')}</p>`;
    return;
  }
  const { items, mi, width } = roadCorridor(h, p, ['conditions', 'passes', 'cameras', 'weather']);
  if (!items.length) {
    el.innerHTML = `<p class="fine" style="padding-left:2px">Nothing from UDOT sits within ${Math.round(width)} miles of the line from ${esc(h.label)} to here. That usually means back roads rather than a clear highway.</p>`;
    return;
  }
  const counts = {};
  for (const r of items) counts[r.kind] = (counts[r.kind] || 0) + 1;
  el.innerHTML = `<div class="sec-title">On the way from ${esc(h.label)} &middot; ${Math.round(mi)} mi</div>
    ${roadShots(items)}
    <div class="card">${items.slice(0, 14).map(roadRow).join('')}</div>
    ${items.length > 14 ? `<p class="fine">Showing the first 14 of ${items.length}.</p>` : ''}
    <p class="fine" style="padding-left:2px">${Object.entries(counts).map(([k, n]) => n + ' ' + (ROAD_KIND[k] || [k])[0].toLowerCase() + (n === 1 ? '' : 's')).join(', ')},
    ordered the way you would pass them. <b>This is a straight line between the two points, widened to ${Math.round(width)} miles - not the road.</b>
    A canyon route can leave that corridor, so a gap here is not a clear road. Conditions are from UDOT and are only as fresh as the last data pull;
    the cameras are live but need a signal. Check them before you leave the valley.</p>`;
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-roadcam]');
  if (!t) return;
  openSheet(`<h3>Road camera</h3><img src="${esc(t.dataset.roadcam)}" alt="" style="width:100%;display:block;border-radius:12px">
    <p class="fine" style="padding:10px 16px">Live still from UDOT. It needs a signal, and it is a picture of a road, not of your hunt.</p>`);
});
