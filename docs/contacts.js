'use strict';

let AC = null, acState = 'idle', acIndex = {};

async function acLoad() {
  if (acState !== 'idle') return;
  acState = 'loading';
  try {
    const response = await fetch('data/access_contacts.json', { cache: 'no-cache' });
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

function acPretty(digits) {
  const phone = String(digits).replace(/\D/g, '');
  return '(' + phone.slice(0, 3) + ') ' + phone.slice(3, 6) + '-' + phone.slice(6);
}

function acWords(text) {
  return esc(text).replace(/(?:\b1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-](\d{4})\b/g,
    (word, area, exchange, line) => '<a href="tel:' + area + exchange + line + '">' + word + '</a>');
}

function acBlock(entry) {
  const words = [entry.contact, entry.asks].filter(text => text).map(acWords);
  const phones = entry.phones || [];
  let h = '<div class="warnbox" style="margin:12px 16px 0"><b>UDWR says:</b> ' + words.join('<br>') + '</div>';
  phones.forEach(phone => {
    const digits = String(phone).replace(/\D/g, '');
    h += '<div class="acts"><a class="btn" href="tel:' + digits + '">Call ' + esc(acPretty(digits)) + '</a></div>';
  });
  if (entry.needs_contact === true && phones.length === 0) h += '<p class="fine" style="padding:10px 16px 0">UDWR asks you to contact the owner and publishes no number for this property. Ask the DWR office for the region.</p>';
  h += '<p class="fine" style="padding:10px 16px 0">The number is the one UDWR publishes for this property. The app takes nothing from any other source. Not legal advice.</p>';
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
