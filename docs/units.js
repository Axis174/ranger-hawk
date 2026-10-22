/* Ranger Hawk - one hunt sheet per polygon with a hunt-list entry.
   Loaded after finder.js. The same renderer is ready for a stopped-clock VM;
   no page builder or per-unit pages are part of this packet. */
'use strict';

const units = { static: false, now: null };
const H_SPECIES = ['Deer', 'Elk', 'Pronghorn', 'Moose', 'Bison', 'Desert Bighorn Sheep', 'Rocky Mountain Bighorn Sheep', 'Mountain Goat'];
let unitPromise = null, unitParamRead = false, unitParam = null, unitParamOpened = false;

function hUnitRows(id) {
  return typeof HU === 'undefined' || !HU ? [] : Object.values(HU.hunts || {}).flat().filter(r => r.boundary_id === Number(id));
}
function hUnit(id) {
  return typeof UNITS === 'undefined' || !UNITS ? null : UNITS.find(u => u.id === Number(id)) || null;
}
function unitLink(id) {
  const u = hUnit(id), rows = hUnitRows(id);
  const slug = u && HU && HU.slugs && Object.prototype.hasOwnProperty.call(HU.slugs, u.n) ? HU.slugs[u.n] : null;
  return slug && rows.length ? `<a href="/?unit=${esc(slug)}"${units.static ? '' : ` data-unit="${u.id}"`}>Open unit</a>` : '';
}
function hUnitParam() {
  if (units.static) return null;
  if (!unitParamRead) {
    unitParamRead = true;
    try { unitParam = new URLSearchParams(location.search).get('unit'); }
    catch (e) { /* no location in a static renderer */ }
  }
  return unitParam;
}
function unitsOpenLink() {
  if (units.static || unitParamOpened || typeof HU === 'undefined' || !HU || !HU.slugs) return false;
  const slug = hUnitParam();
  if (!slug) return false;
  const name = Object.keys(HU.slugs).find(n => HU.slugs[n] === slug);
  const u = name && (UNITS || []).find(u => u.n === name);
  const html = u && sheetUnit(u.id);
  if (!html) return false;
  unitParamOpened = true;
  tab = 'seasons'; seasonsMode = 'find'; render();
  openSheet(html);
  return true;
}
function unitsLoad() {
  if (units.static) return Promise.resolve(false);
  if (unitPromise) return unitPromise;
  unitPromise = Promise.all([fLoadHunts(), loadOdds()]).then(() => {
    const ready = !!(HU && HT && UNITS && ODDS && DB.seasons && DB.config);
    if (ready) unitsOpenLink();
    return ready;
  }).catch(() => false).finally(() => { unitPromise = null; });
  return unitPromise;
}

function hEdition(now) {
  const year = DB.config.hunt_year;
  const bigGame = new Set(['deer', 'elk', 'pronghorn', 'moose', 'bison', 'sheep', 'mountain goat']);
  const ends = (DB.seasons.seasons || []).filter(s => bigGame.has(s.group)).map(s => s.end)
    .concat(((HT || {}).hunts || []).flatMap(h => (h.seasons || []).map(s => s.end))).filter(Boolean).sort();
  const last = ends[ends.length - 1];
  if (!last) return { year, current: true, last: null, expires: null };
  const after = new Date(last + 'T12:00:00Z');
  after.setUTCDate(after.getUTCDate() + 1);
  const expires = after.toISOString().slice(0, 10), fields = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now == null ? (units.now == null ? Date.now() : units.now) : now)).forEach(p => { fields[p.type] = p.value; });
  const day = fields.year + '-' + fields.month + '-' + fields.day;
  return { year, current: day < expires, last, expires };
}
function hHuntRow(hunt) {
  const code = hunt.code + (hunt.marks || []).join('');
  const dates = fHuntDates(hunt);
  const year = ODDS && Object.keys(ODDS.years || {}).sort().pop(), result = year && ODDS.years[year][hunt.code];
  const target = !units.static && result;
  const detail = [...fHuntKind(hunt), dates].map(esc).join(' &middot; ');
  return `<${target ? 'button' : 'div'} class="row"${target ? ` data-draw="${esc(hunt.code)}"` : ''} style="--g:var(--brand)"><span class="pill"></span><span><span class="t">${esc(code)} &middot; ${esc(hunt.name)}</span><span class="s">${detail}</span></span><span class="v"></span></${target ? 'button' : 'div'}>` +
    (result ? ['r', 'x'].map(res => `<p class="fine" style="padding:8px 16px 0">${res === 'r' ? 'residents' : 'nonresidents'}</p><div class="stats">${drawStats(result, res)}</div>`).join('') : '');
}
function sheetUnit(boundaryId) {
  const u = hUnit(boundaryId), rows = hUnitRows(boundaryId);
  if (!u || !rows.length || typeof HT === 'undefined' || !HT || !ODDS || !DB.config || !DB.seasons) return '';
  const edition = hEdition(), year = DB.config.hunt_year;
  const species = H_SPECIES.filter(s => rows.some(r => r.species === s));
  let html = !edition.current ? `<div class="warnbox fbad" style="margin:12px 16px 0">These are the ${esc(year)} hunts. The ${esc(year + 1)} guidebooks have not been read into Ranger Hawk yet.</div>` : '';
  html += `<h3>${esc(u.n)}</h3><p class="where">${species.map(esc).join(' &middot; ')}</p>`;
  html += [...new Set(rows.map(r => r.description))].map(text => `<p class="fine" style="padding:0 16px">${esc(text)}</p>`).join('');
  const base = u.n.split(',')[0];
  const others = (UNITS || []).filter(other => other.id !== u.id && other.n.startsWith(base))
    .sort((a, b) => a.n.localeCompare(b.n, 'en-US'));
  // A name match only: every polygon that shares the base name is listed, and the link goes to those with a sheet.
  if (others.length) html += `<p class="fine" style="padding:0 16px">Other units named ${esc(base)}: ${others.map(other => { const link = unitLink(other.id); return esc(other.n) + (link ? ' ' + link : ''); }).join('; ')}</p>`;
  for (const group of ['Deer', 'Elk', 'Pronghorn', 'Moose', 'Bison', 'Bighorn sheep', 'Mountain Goat']) {
    const entries = rows.filter(r => group === 'Bighorn sheep' ? /Bighorn Sheep$/.test(r.species) : r.species === group);
    if (!entries.length) continue;
    html += `<div class="sec-title" style="padding:0 16px">${esc(group)}</div>`;
    for (const row of entries) {
      html += `<div class="sec-title" style="padding:0 16px">${esc(row.type)}${group === 'Bighorn sheep' ? ' &middot; ' + esc(row.species) : ''}</div><div class="card">`;
      const general = fGeneralRows(row.species, row, null);
      if (general.length) html += general.map(r => `<div class="row" style="--g:var(--brand)"><span class="pill"></span><span><span class="t">${esc(r.t)}</span><span class="s">${r.s}</span></span><span class="v"></span></div>`).join('');
      // A list entry with no hunt number in the guidebook table shows UDWR's own season label, as the finder does.
      else html += fTableHunts(row).map(hHuntRow).join('') || `<div class="row" style="--g:var(--brand)"><span class="pill"></span><span><span class="t">${esc(row.unit)}</span><span class="s">${esc(row.season)}</span></span><span class="v"></span></div>`;
      html += '</div>';
    }
  }
  const pulled = /\bpulled (\d{4}-\d{2}-\d{2})\b/.exec(HU._source || '');
  const oddsYear = ODDS && Object.keys(ODDS.years || {}).sort().pop();
  html += `<p class="fine" style="padding:14px 16px">Hunts: UDWR's ${esc(year)} hunt boundary lists, pulled ${esc(pulled ? pulled[1] : '')}. Dates: the ${esc(year)} Big Game Field Regulations (general seasons) and the ${esc(year)} Big Game Application Guidebook, ${esc(HT._edition.reissued)} (drawn hunts). Last year's draw: ${esc(oddsYear || '')}. A mark after a hunt number is the guidebook's footnote; read it there.</p>`;
  return html;
}

document.addEventListener('click', e => {
  const target = e.target.closest('[data-unit]');
  if (!target || units.static) return;
  e.preventDefault();
  unitsLoad().then(() => {
    const html = sheetUnit(target.dataset.unit);
    if (html) openSheet(html);
  });
});
