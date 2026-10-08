/* Ranger Hawk - trail camera log. Everything here stays on the phone: photos are
   read where they are, shrunk to a 640 px copy, and kept in the browser's own
   database (IndexedDB). Nothing is uploaded, and there is no account.

   What it does: camera sites, import with the time read from each photo, automatic
   flagging of black / featureless frames, a "most likely an animal first" sort,
   quick tagging, and patterns by hour, date and moon against legal shooting light.

   Loaded as a second classic script after app.js and shares its globals
   ($, esc, openSheet, closeSheet, render, tab, SUN, DB, MAP, home). */
'use strict';

const CAM_TAGS = [
  ['elk_bull', 'Elk bull', '#7A1F5C'], ['elk_cow', 'Elk cow / calf', '#A8578E'], ['deer_buck', 'Deer buck', '#8A5A2B'],
  ['deer_doe', 'Deer doe / fawn', '#B98C5E'], ['moose', 'Moose', '#3F3F46'], ['bear', 'Bear', '#1c1c1c'],
  ['predator', 'Lion / coyote', '#B45309'], ['other', 'Other animal', '#64748B'], ['human', 'Person / vehicle', '#C62828'],
  ['none', 'Nothing', '#9CA3AF']
];
const CAM_TAG = Object.fromEntries(CAM_TAGS.map(t => [t[0], t]));
const CAM_GROUPS = [['any', 'All animals', t => t && t !== 'none' && t !== 'human'], ['elk_bull', 'Elk bulls', t => t === 'elk_bull'],
  ['elk', 'All elk', t => t === 'elk_bull' || t === 'elk_cow'], ['deer', 'All deer', t => t === 'deer_buck' || t === 'deer_doe'],
  ['deer_buck', 'Deer bucks', t => t === 'deer_buck'], ['human', 'People', t => t === 'human']];
const GW = 96, GH = 46;                      // grey fingerprint size; the camera's info strip is left out
let camView = 'home', camSite = null, camFilter = 'todo', camGroup = 'any', camBusy = '', camRules = null, camCache = { sites: null, photos: {} };

/* ------------------------------------------------------------- storage ---- */
let camDbP = null;
function camDb() {
  if (!camDbP) camDbP = new Promise((ok, no) => {
    const rq = indexedDB.open('rangerhawk-cams', 1);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      d.createObjectStore('sites', { keyPath: 'id' });
      const p = d.createObjectStore('photos', { keyPath: 'id' }); p.createIndex('site', 'site');
    };
    rq.onsuccess = () => ok(rq.result); rq.onerror = () => no(rq.error);
  });
  return camDbP;
}
async function camTx(store, mode, fn) {
  const d = await camDb();
  return new Promise((ok, no) => { const tx = d.transaction(store, mode); const out = fn(tx.objectStore(store)); tx.oncomplete = () => ok(out && out.result !== undefined ? out.result : out); tx.onerror = () => no(tx.error); });
}
const camAll = (store, index, key) => camTx(store, 'readonly', s => (index ? s.index(index).getAll(key) : s.getAll()));
const camPut = (store, v) => camTx(store, 'readwrite', s => s.put(v));
const camDel = (store, k) => camTx(store, 'readwrite', s => s.delete(k));
async function camSites() { if (!camCache.sites) camCache.sites = (await camAll('sites')).sort((a, b) => a.name.localeCompare(b.name)); return camCache.sites; }
async function camPhotos(site) { if (!camCache.photos[site]) camCache.photos[site] = (await camAll('photos', 'site', site)).sort((a, b) => a.iso < b.iso ? -1 : 1); return camCache.photos[site]; }
const camFlush = site => { camCache.sites = null; if (site) delete camCache.photos[site]; else camCache.photos = {}; };

/* ---------------------------------------------------------------- EXIF ---- */
/* Just enough of a reader to get the capture time, the camera and (if the camera
   wrote one) a GPS position. Trail cameras write the time as local wall-clock with
   no zone, which is what we want for hour-of-day patterns. */
function camExif(buf) {
  const v = new DataView(buf), out = {};
  if (v.getUint16(0) !== 0xFFD8) return out;
  let o = 2;
  while (o + 4 < v.byteLength) {
    const m = v.getUint16(o), len = v.getUint16(o + 2);
    if (m === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) { parse(o + 10); break; }
    if ((m & 0xFF00) !== 0xFF00) break;
    o += 2 + len;
  }
  return out;
  function parse(t) {
    const le = v.getUint16(t) === 0x4949, u16 = p => v.getUint16(p, le), u32 = p => v.getUint32(p, le);
    const str = (p, n) => { let s = ''; for (let i = 0; i < n && p + i < v.byteLength; i++) { const c = v.getUint8(p + i); if (!c) break; s += String.fromCharCode(c); } return s.trim(); };
    const ifd = (p, fn) => { if (p <= 0 || t + p + 2 > v.byteLength) return; const n = u16(t + p); for (let i = 0; i < n; i++) { const e = t + p + 2 + i * 12; if (e + 12 > v.byteLength) return; fn(u16(e), u16(e + 2), u32(e + 4), e + 8); } };
    const val = (cnt, e, size) => (cnt * size > 4 ? t + u32(e) : e);
    const rat3 = p => [0, 1, 2].map(i => u32(p + i * 8) / (u32(p + i * 8 + 4) || NaN));
    let exifP = 0, gpsP = 0;
    ifd(u32(t + 4), (tag, type, cnt, e) => {
      if (tag === 0x010F) out.make = str(val(cnt, e, 1), cnt); if (tag === 0x0110) out.model = str(val(cnt, e, 1), cnt);
      if (tag === 0x0132) out.time = out.time || str(val(cnt, e, 1), cnt);
      if (tag === 0x8769) exifP = u32(e); if (tag === 0x8825) gpsP = u32(e);
    });
    ifd(exifP, (tag, type, cnt, e) => { if (tag === 0x9003) out.time = str(val(cnt, e, 1), cnt); });
    const g = {};
    ifd(gpsP, (tag, type, cnt, e) => { if (tag === 1) g.ns = str(e, 1); if (tag === 3) g.ew = str(e, 1); if (tag === 2) g.lat = rat3(t + u32(e)); if (tag === 4) g.lon = rat3(t + u32(e)); });
    const dd = a => a && a.every(isFinite) ? a[0] + a[1] / 60 + a[2] / 3600 : null;
    const la = dd(g.lat), lo = dd(g.lon);
    if (la && lo) { out.lat = g.ns === 'S' ? -la : la; out.lon = g.ew === 'W' ? -lo : lo; }
  }
}
const camIso = (t, file) => {
  const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(t || '');
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  const d = new Date(file.lastModified), p = n => String(n).padStart(2, '0');       // no EXIF: fall back to the file's date
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/* -------------------------------------------------------------- import ---- */
function camLoadImg(file) {
  return new Promise((ok, no) => { const u = URL.createObjectURL(file), im = new Image(); im.onload = () => { URL.revokeObjectURL(u); ok(im); }; im.onerror = () => { URL.revokeObjectURL(u); no(new Error('not a picture')); }; im.src = u; });
}
async function camProcess(file, site) {
  const ex = camExif(await file.slice(0, 196608).arrayBuffer());
  const im = await camLoadImg(file), W = 640, H = Math.round(im.naturalHeight * W / im.naturalWidth);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  cv.getContext('2d').drawImage(im, 0, 0, W, H);
  const thumb = await new Promise(ok => cv.toBlob(ok, 'image/jpeg', 0.72));
  const sm = document.createElement('canvas'); sm.width = GW; sm.height = 54;
  const sx = sm.getContext('2d', { willReadFrequently: true }); sx.drawImage(cv, 0, 0, GW, 54);
  const px = sx.getImageData(0, 0, GW, GH).data, g = new Uint8Array(GW * GH);
  let lum = 0, sat = 0;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) { const r = px[i], gg = px[i + 1], b = px[i + 2]; const y = (r + gg + b) / 3; g[j] = y; lum += y; sat += Math.max(r, gg, b) - Math.min(r, gg, b); }
  lum /= g.length; sat /= g.length;
  let con = 0; for (let j = 0; j < g.length; j++) con += (g[j] - lum) ** 2; con = Math.sqrt(con / g.length);
  const iso = camIso(ex.time, file);
  return { id: site + '|' + file.name + '|' + file.size, site, name: file.name, size: file.size, iso, cam: [ex.make, ex.model].filter(Boolean).join(' '),
    lat: ex.lat || null, lon: ex.lon || null, lum: Math.round(lum), con: Math.round(con), night: sat < 6,
    reject: lum < 28 || con < 12,              // black, or featureless: almost never an animal, but never hidden
    score: 0, tag: null, n: 1, g, thumb };
}
/* Rank a site's night photos by how much each differs from the site's typical
   empty frame (the per-pixel median). Big bright animal = big difference. It is a
   sort order, not a verdict: animals at the dark edge of the flash score low. */
async function camScore(site) {
  const all = await camPhotos(site), pool = all.filter(p => p.night && !p.reject && p.g);
  if (pool.length < 8) return;
  const sample = pool.length > 160 ? pool.filter((_, i) => i % Math.ceil(pool.length / 160) === 0) : pool;
  const bg = new Uint8Array(GW * GH), col = new Uint8Array(sample.length);
  for (let j = 0; j < bg.length; j++) { for (let k = 0; k < sample.length; k++) col[k] = sample[k].g[j]; bg[j] = col.slice().sort()[sample.length >> 1]; }
  const d = await camDb(), tx = d.transaction('photos', 'readwrite'), st = tx.objectStore('photos');
  for (const p of pool) { let c = 0; for (let j = 0; j < bg.length; j++) if (Math.abs(p.g[j] - bg[j]) > 45) c++; p.score = c / bg.length; st.put(p); }
  await new Promise(ok => { tx.oncomplete = ok; });
}
async function camImport(site, files) {
  const list = [...files].filter(f => /image\/(jpeg|png)|\.jpe?g$/i.test(f.type + f.name));
  if (!list.length) { camBusy = 'No photos in that selection.'; render(); return; }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  const have = new Set((await camPhotos(site)).map(p => p.id)); let added = 0, skipped = 0, failed = 0;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (have.has(site + '|' + f.name + '|' + f.size)) { skipped++; continue; }
    try { await camPut('photos', await camProcess(f, site)); added++; } catch (e) { failed++; }
    if (i % 5 === 0) { camBusy = `Reading photo ${i + 1} of ${list.length}…`; const el = $('cambusy'); if (el) el.textContent = camBusy; }
  }
  camFlush(site);
  camBusy = 'Sorting…'; if ($('cambusy')) $('cambusy').textContent = camBusy;
  await camScore(site); camFlush(site);
  camBusy = `Added ${added}${skipped ? ', ' + skipped + ' already here' : ''}${failed ? ', ' + failed + ' unreadable' : ''}.`;
  camView = 'site'; render();
}

/* ------------------------------------------------------------ analysis ---- */
const camHour = p => +p.iso.slice(11, 13) + (+p.iso.slice(14, 16)) / 60;
function camVisits(photos) {                 // photos within 5 minutes of each other are one visit
  const out = []; let cur = null;
  for (const p of photos) {
    const t = Date.parse(p.iso);
    if (!cur || t - cur.last > 300000) { cur = { first: p, last: t, tags: new Set(), n: 0 }; out.push(cur); }
    cur.last = t; cur.n++; if (p.tag) cur.tags.add(p.tag);
  }
  return out;
}
function camLight(site, iso) {               // legal shooting light that day, as decimal hours in Mountain time
  if (!SUN) return null;
  const d = new Date(iso.slice(0, 10) + 'T12:00:00'), t = SUN.getTimes(d, site.lat || 40.76, site.lon || -111.89);
  if (!t.sunrise || isNaN(t.sunrise)) return null;
  const hr = x => { const s = x.toLocaleTimeString('en-GB', { timeZone: 'America/Denver', hour12: false }); return +s.slice(0, 2) + (+s.slice(3, 5)) / 60; };
  return [hr(t.sunrise) - 0.5, hr(t.sunset) + 0.5];
}
/* Was the sun up when the camera fired? The night flag next to it is about the
   picture (a grey infrared frame), not the sky: this camera shoots infrared at
   noon as well, so the two have to be said separately. */
function camDay(site, iso) {
  if (!SUN) return null;
  const d = new Date(iso.slice(0, 10) + 'T12:00:00'), t = SUN.getTimes(d, (site && site.lat) || 40.76, (site && site.lon) || -111.89);
  if (!t.sunrise || isNaN(t.sunrise) || !t.sunset || isNaN(t.sunset)) return null;
  const hr = x => { const s = x.toLocaleTimeString('en-GB', { timeZone: 'America/Denver', hour12: false }); return +s.slice(0, 2) + (+s.slice(3, 5)) / 60; };
  const h = camHour({ iso });
  return h >= hr(t.sunrise) && h <= hr(t.sunset);
}
const camMoon = iso => { if (!SUN) return null; const f = SUN.getMoonIllumination(new Date(iso)).fraction; return f < 0.25 ? 'Dark moon' : f < 0.75 ? 'Half moon' : 'Bright moon'; };

/* ---------------------------------------------------------------- rules --- */
function camLoadRules() { if (camRules) return; camRules = {}; fetch('data/' + STATE + '/cam_rules.json').then(r => r.json()).then(j => { camRules = j && j.states ? j : {}; if (tab === 'cams') render(); }).catch(() => {}); }
function camRuleBox(site) {
  const st = (site && site.state) || 'UT', r = camRules && camRules.states && camRules.states[st];
  if (!r) return `<div class="warnbox" style="margin-top:12px">Trail camera rules differ by state and change often. Check the state wildlife agency before you hang a camera.</div>`;
  const now = new Date(), md = (now.getMonth() + 1) * 100 + now.getDate();
  const inBan = r.ban_from && r.ban_to && (r.ban_from <= r.ban_to ? md >= r.ban_from && md <= r.ban_to : md >= r.ban_from || md <= r.ban_to);
  const hot = inBan && (!site || site.land !== 'private' || r.scope === 'all');
  return `<div class="warnbox" style="margin-top:12px${hot ? ';border-left-color:var(--crit)' : ''}"><b>${esc(r.name)}${hot ? ' - restriction in effect today' : ''}.</b> ${esc(r.plain)}
    <br><span style="font-size:11.5px;opacity:.8">${esc(r.cite || '')}${r.checked ? ' Checked ' + esc(r.checked) + '.' : ''} Not legal advice; the agency's current regulations govern.</span></div>`;
}

/* ---------------------------------------------------------------- views --- */
function vCams() {
  camLoadRules();
  const busy = `<p class="fine" id="cambusy" style="padding-left:2px">${esc(camBusy)}</p>`;
  if (camView === 'home' || !camSite) { camHomeFill(); return `<div id="camroot"><p class="empty">Opening the camera log&hellip;</p></div>${busy}`; }
  camSiteFill(); return `<div id="camroot"><p class="empty">Loading&hellip;</p></div>${busy}`;
}
async function camHomeFill() {
  const sites = await camSites(), counts = {};
  for (const s of sites) counts[s.id] = (await camPhotos(s.id)).length;
  let est = ''; try { const e = await navigator.storage.estimate(); est = ` Using ${(e.usage / 1048576).toFixed(0)} MB on this phone.`; } catch (e) { /* not supported */ }
  const el = $('camroot'); if (!el || tab !== 'cams' || camView !== 'home') return;
  el.innerHTML = `${camRuleBox(null)}
    <div class="sec-title">Camera sites</div><div class="card">${sites.map(s => `<button class="row" data-cam-open="${esc(s.id)}" style="--g:var(--brand)"><span class="pill"></span>
      <span><span class="t">${esc(s.name)}</span><span class="s">${esc(s.land === 'private' ? 'Private land' : s.land === 'public' ? 'Public land' : 'Land type not set')} &middot; ${esc(s.state || 'UT')}</span></span>
      <span class="v">${counts[s.id]}<small>photos</small></span></button>`).join('') || '<p class="empty">No camera sites yet. Add one, then bring in the photos from its card.</p>'}</div>
    <div class="acts" style="padding:12px 0 0"><button class="btn" data-cam-new="1">Add a camera site</button></div>
    <p class="fine" style="padding-left:2px"><b>Your photos never leave this phone.</b> The app keeps a small copy of each one in its own storage, reads the time the camera stamped on it, and works with no signal.${est}
    There is no backup: if the phone is lost or the app's data is cleared, the log goes with it. Keep the SD cards or your originals.</p>`;
}
async function camSiteFill() {
  const site = (await camSites()).find(s => s.id === camSite);
  if (!site) { camView = 'home'; render(); return; }
  const photos = await camPhotos(site.id), el = $('camroot');
  if (!el || tab !== 'cams') return;
  const head = `<div class="acts" style="padding:12px 0 0"><button class="btn ghost" data-cam-home="1">&larr; Sites</button>
    <button class="btn ghost" data-cam-view="site" aria-pressed="${camView === 'site'}">${esc(site.name)}</button>
    <button class="btn ghost" data-cam-view="review">Photos</button><button class="btn ghost" data-cam-view="patterns">Patterns</button></div>`;
  if (camView === 'review') { el.innerHTML = head + camReviewHtml(site, photos); return; }
  if (camView === 'patterns') { el.innerHTML = head + camPatternsHtml(site, photos); return; }
  const tagged = photos.filter(p => p.tag).length, rej = photos.filter(p => p.reject && !p.tag).length, span = photos.length ? photos[0].iso.slice(0, 10) + ' to ' + photos[photos.length - 1].iso.slice(0, 10) : '';
  el.innerHTML = head + camRuleBox(site) + `
    <div class="sec-title">${esc(site.name)}</div><div class="card"><div class="stats">
      <div class="stat"><div class="k">Photos</div><div class="v">${photos.length}</div></div>
      <div class="stat"><div class="k">Tagged</div><div class="v">${tagged}</div></div>
      <div class="stat"><div class="k">Black / blank</div><div class="v">${rej}</div></div>
      <div class="stat"><div class="k">Visits</div><div class="v">${camVisits(photos.filter(p => !p.reject)).length}</div></div></div>
      <p class="fine">${span ? 'Photos from ' + esc(span) + '. ' : ''}${site.lat ? 'Pinned at ' + site.lat.toFixed(4) + ', ' + site.lon.toFixed(4) + '.' : 'No location set - patterns use Salt Lake City for sunrise and sunset.'} ${esc(site.notes || '')}</p></div>
    <div class="acts" style="padding:12px 0 0"><label class="btn" style="cursor:pointer">Bring in photos<input type="file" id="camfile" accept="image/jpeg,image/png" multiple hidden></label>
      <button class="btn ghost" data-cam-gps="1">Pin at my GPS</button><button class="btn ghost" data-cam-edit="1">Edit</button></div>
    <p class="fine" style="padding-left:2px">On an iPhone: put the SD card in a card reader (or AirDrop the photos to the phone), tap Bring in photos, choose Photo Library or Browse, and select the lot. A full card can take a few minutes.</p>
    <div class="acts" style="padding:4px 0 0"><button class="btn ghost" data-cam-export="1">Export this log (CSV)</button><button class="btn ghost" data-cam-delete="1" style="color:var(--crit);border-color:var(--crit)">Delete site</button></div>`;
}
const camThumbs = new Map();
function camUrl(p) { if (!camThumbs.has(p.id)) camThumbs.set(p.id, URL.createObjectURL(p.thumb)); return camThumbs.get(p.id); }
function camPick(photos) {
  if (camFilter === 'todo') return photos.filter(p => !p.tag && !p.reject).sort((a, b) => b.score - a.score);
  if (camFilter === 'blank') return photos.filter(p => p.reject && !p.tag);
  if (camFilter === 'animals') return photos.filter(p => p.tag && p.tag !== 'none');
  if (camFilter === 'none') return photos.filter(p => p.tag === 'none');
  return photos;
}
function camReviewHtml(site, photos) {
  const list = camPick(photos), blank = photos.filter(p => p.reject && !p.tag).length;
  const chip = (k, l, n) => `<button class="chip" data-cam-filter="${k}" aria-pressed="${camFilter === k}">${l} ${n}</button>`;
  return `<div class="chipsrow" style="margin-top:12px">${chip('todo', 'To tag', photos.filter(p => !p.tag && !p.reject).length)}${chip('animals', 'Animals', photos.filter(p => p.tag && p.tag !== 'none').length)}${chip('blank', 'Black / blank', blank)}${chip('none', 'Nothing', photos.filter(p => p.tag === 'none').length)}${chip('all', 'All', photos.length)}</div>
    ${camFilter === 'blank' && blank ? `<div class="acts" style="padding:0 0 10px"><button class="btn ghost" data-cam-bulknone="1">Mark all ${blank} as Nothing</button></div>` : ''}
    ${camFilter === 'todo' ? '<p class="fine" style="padding:0 2px 8px">Sorted with the most likely animals first. Photos near the bottom are usually empty, but an animal standing at the dark edge of the flash can hide there, so nothing is removed for you.</p>' : ''}
    <div class="camgrid">${list.slice(0, 150).map(p => `<button data-cam-photo="${esc(p.id)}"><img loading="lazy" src="${camUrl(p)}" alt=""><span>${esc(p.iso.slice(5, 10))} ${esc(p.iso.slice(11, 16))}</span>${p.tag ? `<i style="background:${CAM_TAG[p.tag][2]}"></i>` : ''}</button>`).join('') || '<p class="empty">Nothing in this group.</p>'}</div>
    ${list.length > 150 ? `<p class="fine">Showing 150 of ${list.length}. Tag some and the rest move up.</p>` : ''}`;
}
async function camOpenPhoto(id) {
  const photos = await camPhotos(camSite), list = camPick(photos), i = list.findIndex(p => p.id === id), p = list[i];
  if (!p) return;
  const site = (await camSites()).find(s => s.id === camSite);
  const day = camDay(site, p.iso);                     // the sky, from the site's own sunrise and sunset
  const when = day == null ? '' : day ? ' &middot; daylight' : ' &middot; after dark';
  const moon = day === false ? camMoon(p.iso) : null;  // meaningless on a photo taken at noon
  openSheet(`<img src="${camUrl(p)}" alt="" style="width:100%;display:block;border-radius:12px 12px 0 0">
    <p class="where mono" style="padding-top:10px">${esc(p.iso.replace('T', ' '))}${when}${p.night ? ' &middot; infrared' : ' &middot; colour'}${moon ? ' &middot; ' + moon : ''} &middot; ${i + 1} of ${list.length}</p>
    <div class="camtags">${CAM_TAGS.map(t => `<button data-cam-tag="${t[0]}" data-cam-id="${esc(p.id)}" aria-pressed="${p.tag === t[0]}" style="--c:${t[2]}">${t[1]}</button>`).join('')}</div>
    <div class="acts"><button class="btn ghost" data-cam-photo="${esc((list[i - 1] || {}).id || '')}"${i ? '' : ' disabled'}>&larr; Previous</button>
      <div class="stepper"><button data-cam-n="-1" data-cam-id="${esc(p.id)}">&minus;</button><span><b>${p.n || 1}</b> animal${(p.n || 1) === 1 ? '' : 's'}</span><button data-cam-n="1" data-cam-id="${esc(p.id)}">+</button></div>
      <button class="btn ghost" data-cam-photo="${esc((list[i + 1] || {}).id || '')}"${list[i + 1] ? '' : ' disabled'}>Next &rarr;</button></div>
    <p class="fine" style="padding:10px 16px">${esc(p.name)}${p.cam ? ' &middot; ' + esc(p.cam) : ''}. Tapping a tag saves it and moves to the next photo.</p>`);
}
function camPatternsHtml(site, photos) {
  const grp = CAM_GROUPS.find(g => g[0] === camGroup) || CAM_GROUPS[0], tagged = photos.filter(p => p.tag).length;
  if (!tagged) return `<p class="empty" style="margin-top:20px">Tag some photos first. Patterns are built from what you tag, not guessed.</p>`;
  const visits = camVisits(photos.filter(p => !p.reject || p.tag)).filter(v => [...v.tags].some(grp[2]));
  const byHour = new Array(24).fill(0), byDay = {}, byMoon = { 'Dark moon': 0, 'Half moon': 0, 'Bright moon': 0 }; let inLight = 0, dawn = [], dusk = [];
  for (const v of visits) {
    const p = v.first, h = camHour(p); byHour[Math.floor(h)]++; byDay[p.iso.slice(0, 10)] = (byDay[p.iso.slice(0, 10)] || 0) + 1;
    const m = camMoon(p.iso); if (m) byMoon[m]++;
    const L = camLight(site, p.iso); if (L) { dawn.push(L[0]); dusk.push(L[1]); if (h >= L[0] && h <= L[1]) inLight++; }
  }
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null, L0 = avg(dawn), L1 = avg(dusk), mx = Math.max(1, ...byHour);
  const bars = byHour.map((n, h) => `<rect x="${h * 13 + 2}" y="${70 - n / mx * 62}" width="10" height="${n / mx * 62}" rx="1.5" fill="${L0 != null && h + 0.5 >= L0 && h + 0.5 <= L1 ? 'var(--brand)' : 'var(--ink)'}"/>${n ? `<text x="${h * 13 + 7}" y="${66 - n / mx * 62}" text-anchor="middle" font-size="7" fill="var(--muted)">${n}</text>` : ''}`).join('');
  const peak = byHour.map((n, h) => [n, h]).sort((a, b) => b[0] - a[0]).filter(x => x[0]).slice(0, 3).map(x => `${x[1] % 12 || 12} ${x[1] < 12 ? 'AM' : 'PM'}`);
  const days = Object.keys(byDay).sort(), pct = visits.length ? Math.round(inLight / visits.length * 100) : 0;
  return `<div class="chipsrow" style="margin-top:12px">${CAM_GROUPS.map(g => `<button class="chip" data-cam-group="${g[0]}" aria-pressed="${camGroup === g[0]}">${g[1]}</button>`).join('')}</div>
    <div class="sec-title">${esc(grp[1])} &middot; ${visits.length} visit${visits.length === 1 ? '' : 's'}</div><div class="card" style="padding:12px 12px 4px">
    ${visits.length ? `<svg viewBox="0 0 316 86" style="width:100%;display:block">${L0 != null ? `<rect x="${L0 * 13 + 2}" y="4" width="${(L1 - L0) * 13}" height="66" fill="var(--brand)" opacity=".1"/>` : ''}${bars}
      ${[0, 6, 12, 18].map(h => `<text x="${h * 13 + 2}" y="82" font-size="8" fill="var(--muted)">${h % 12 || 12}${h < 12 ? 'a' : 'p'}</text>`).join('')}<text x="314" y="82" text-anchor="end" font-size="8" fill="var(--muted)">midnight</text></svg>
    <p class="fine" style="padding:6px 2px 8px"><b>${pct}% of visits were in legal shooting light</b> (${inLight} of ${visits.length}; blue bars and shaded band). ${peak.length ? 'Busiest hours: ' + peak.join(', ') + '. ' : ''}
    ${pct < 25 ? 'This spot is mostly a night spot: the animals are here, but not when you can legally shoot. Look for where they go at first light. ' : pct > 60 ? 'Daylight activity is strong here. ' : ''}
    Moon: ${Object.entries(byMoon).map(([k, n]) => `${k.toLowerCase()} ${n}`).join(', ')}. Seen on ${days.length} day${days.length === 1 ? '' : 's'}${days.length ? ', ' + days[0] + ' to ' + days[days.length - 1] : ''}.</p>` : '<p class="empty">No visits tagged in this group.</p>'}</div>
    <p class="fine" style="padding-left:2px">A visit is a run of photos less than five minutes apart, so a burst of 12 frames counts once. Patterns come only from photos you have tagged: ${tagged} of ${photos.length} so far. Legal light is worked out for ${site.lat ? 'the pin' : 'Salt Lake City'} on each photo's own date.</p>`;
}
function camSiteForm(site) {
  const s = site || { name: '', land: '', state: 'UT', notes: '' }, states = ['UT', 'AZ', 'CO', 'ID', 'MT', 'NM', 'NV', 'WY', 'OR', 'WA', 'CA', 'AK', 'KS', 'Other'];
  openSheet(`<h3>${site ? 'Edit camera site' : 'New camera site'}</h3>
    <div class="camform"><label>Name<input id="cf-name" value="${esc(s.name)}" placeholder="Lake Creek spring"></label>
    <label>Land<select id="cf-land"><option value="">Choose&hellip;</option><option value="private"${s.land === 'private' ? ' selected' : ''}>Private</option><option value="public"${s.land === 'public' ? ' selected' : ''}>Public (forest, BLM, state)</option></select></label>
    <label>State<select id="cf-state">${states.map(x => `<option${x === (s.state || 'UT') ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
    <label>Notes<input id="cf-notes" value="${esc(s.notes || '')}" placeholder="Facing north across the wallow"></label></div>
    <div class="acts"><button class="btn" data-cam-save="${esc(site ? site.id : '')}">Save</button></div>
    <p class="fine" style="padding:10px 16px">Land and state decide which trail camera rule the app shows you. The location stays on this phone.</p>`);
}

/* --------------------------------------------------------------- events --- */
document.addEventListener('change', e => { if (e.target.id === 'camfile' && e.target.files.length) { camBusy = 'Starting…'; if ($('cambusy')) $('cambusy').textContent = camBusy; camImport(camSite, e.target.files); } });
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-cam-open],[data-cam-new],[data-cam-home],[data-cam-view],[data-cam-filter],[data-cam-photo],[data-cam-tag],[data-cam-n],[data-cam-group],[data-cam-save],[data-cam-edit],[data-cam-gps],[data-cam-delete],[data-cam-bulknone],[data-cam-export]');
  if (!t) return;
  const d = t.dataset;
  if (d.camOpen) { camSite = d.camOpen; camView = 'site'; camBusy = ''; render(); window.scrollTo(0, 0); return; }
  if (d.camHome) { camView = 'home'; camSite = null; camBusy = ''; render(); return; }
  if (d.camView) { camView = d.camView; render(); return; }
  if (d.camFilter) { camFilter = d.camFilter; render(); return; }
  if (d.camGroup) { camGroup = d.camGroup; render(); return; }
  if (d.camNew) { camSiteForm(null); return; }
  if (d.camEdit) { camSiteForm((await camSites()).find(s => s.id === camSite)); return; }
  if ('camSave' in d) {
    const name = $('cf-name').value.trim(); if (!name) { $('cf-name').focus(); return; }
    const old = d.camSave ? (await camSites()).find(s => s.id === d.camSave) : null;
    const site = Object.assign(old || { id: 's' + Date.now(), lat: null, lon: null }, { name, land: $('cf-land').value, state: $('cf-state').value, notes: $('cf-notes').value.trim() });
    await camPut('sites', site); camFlush(); camSite = site.id; camView = 'site'; closeSheet(); render(); return;
  }
  if (d.camGps) {
    if (!navigator.geolocation) return;
    camBusy = 'Getting a GPS fix…'; render();
    navigator.geolocation.getCurrentPosition(async pos => { const s = (await camSites()).find(x => x.id === camSite); s.lat = pos.coords.latitude; s.lon = pos.coords.longitude; await camPut('sites', s); camFlush(); camBusy = 'Pinned.'; render(); },
      err => { camBusy = 'No GPS fix: ' + (err.message || 'refused'); render(); }, { enableHighAccuracy: true, timeout: 20000 });
    return;
  }
  if (d.camDelete) {
    if (!confirm('Delete this camera site and every photo copy and tag in it? This cannot be undone.')) return;
    for (const p of await camPhotos(camSite)) await camDel('photos', p.id);
    await camDel('sites', camSite); camFlush(); camSite = null; camView = 'home'; render(); return;
  }
  if (d.camBulknone) { for (const p of (await camPhotos(camSite)).filter(x => x.reject && !x.tag)) { p.tag = 'none'; await camPut('photos', p); } camFlush(camSite); render(); return; }
  if (d.camExport) {
    const site = (await camSites()).find(s => s.id === camSite), rows = [['site', 'file', 'taken', 'tag', 'animals', 'infrared', 'black_or_blank']];
    for (const p of await camPhotos(camSite)) rows.push([site.name, p.name, p.iso, p.tag ? CAM_TAG[p.tag][1] : '', p.tag && p.tag !== 'none' ? p.n || 1 : '', p.night ? 'yes' : 'no', p.reject ? 'yes' : 'no']);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n')], { type: 'text/csv' }));
    a.download = site.name.replace(/[^\w-]+/g, '_') + '_camera_log.csv'; a.click(); return;
  }
  if ('camPhoto' in d) { if (d.camPhoto) camOpenPhoto(d.camPhoto); return; }
  if (d.camTag || d.camN) {
    const photos = await camPhotos(camSite), p = photos.find(x => x.id === d.camId); if (!p) return;
    if (d.camN) { p.n = Math.max(1, (p.n || 1) + (+d.camN)); await camPut('photos', p); camOpenPhoto(p.id); return; }
    const list = camPick(photos), i = list.findIndex(x => x.id === p.id), next = list[i + 1] || list[i - 1];
    p.tag = p.tag === d.camTag ? null : d.camTag; await camPut('photos', p);
    render();
    if (p.tag && next && camFilter === 'todo') camOpenPhoto(next.id); else if (p.tag && list[i + 1]) camOpenPhoto(list[i + 1].id); else camOpenPhoto(p.id);
  }
});
