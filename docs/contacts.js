'use strict';

let AC = null, acState = 'idle', acIndex = {};

async function acLoad() {
  if (acState !== 'idle') return;
  acState = 'loading';
  try {
    const response = await fetch('data/' + STATE + '/access_contacts.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('Access contacts unavailable');
    const data = await response.json();
    if (!data || !Array.isArray(data.properties)) throw new Error('Invalid access contacts');
    const index = {};
    data.properties.forEach(entry => entry.ids.forEach(id => { index[id] = entry; }));
    AC = data; acIndex = index; acState = 'ready';
    render();
  } catch (e) {
    AC = { properties: [] }; acIndex = {}; acState = 'failed';
  }
}

function acFor(id) {
  if (!AC) acLoad();
  return Object.prototype.hasOwnProperty.call(acIndex, id) ? acIndex[id] : null;
}

function acList() {
  return AC ? AC.properties.filter(entry => entry.needs_contact === true) : [];
}

/* No tap-to-call for a landowner, and no formatting of one. The builder redacts these
   numbers before they are written, and the app refuses to present one even if a future
   change let one through: a second lock on the same door. Agency office numbers live in
   config.json and are shown on the Contacts screen as they always were. */
function acWords(text) {
  return esc(text);
}

function acBlock(entry) {
  /* entry.asks is UDWR's own wording and is quoted as theirs. entry.contact is this app's
     routing line, so it is shown as the app's, not attributed to UDWR. */
  let h = '';
  if (entry.asks) h += '<div class="warnbox" style="margin:12px 16px 0"><b>UDWR says:</b> ' + acWords(entry.asks) + '</div>';
  if (entry.needs_contact === true) h += '<p class="fine" style="padding:10px 16px 0"><b>You must reach the owner before you set foot on this property.</b> '
    + 'UDWR publishes the number on its Walk-In Access map at wildlife.utah.gov/walkinaccess. This app does not carry landowners\' personal numbers. '
    + 'If you are turned away, call the DWR office for the region. Not legal advice.</p>';
  return h;
}

function acSheet(entry) {
  let h = '<h3>' + esc(entry.name) + '</h3><p class="where">' + esc(entry.county) + ' County &middot; ' + esc(entry.program) + '</p>';
  if (entry.lat != null && entry.lon != null && Number.isFinite(Number(entry.lat)) && Number.isFinite(Number(entry.lon))) {
    h += '<div class="acts"><a class="btn" href="https://maps.apple.com/?daddr=' + esc(String(Number(entry.lat))) + ',' + esc(String(Number(entry.lon))) + '&dirflg=d">Directions</a></div>';
  }
  return h + acBlock(entry);
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-ac]');
  if (!t) return;
  const entry = acFor(t.dataset.ac);
  if (entry) openSheet(acSheet(entry));
});

