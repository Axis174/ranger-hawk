/* Ranger Hawk - the privacy page, the "how it makes money" page, the paid-link
   slot and the (switched-off) visitor count.

   Loaded last; shares the globals of the other scripts ($, esc, tab, render).
   Nothing here earns money yet and no paid link is filled in. */
'use strict';

/* Visitor count. Empty string = off: no request is made and the Privacy screen says so.
   Set this to a GoatCounter site code (the part before .goatcounter.com) to switch it on;
   the Privacy screen changes with it. See README, "Privacy, money and paid links". */
const COUNTER_CODE = '';

/* ------------------------------------------------------------ paid links --- */
/* data/paid_links.json is { "links": [ { slot, company, label, url } ] }. Loaded the way
   contacts.js loads its file: fetched once into a global, then the screen is redrawn. */
let PL = null, plState = 'idle';

/* The slots that a screen actually draws. A link whose slot is not here shows nowhere,
   so the money screen does not list it as "in the app". Add a slot here when a screen
   starts calling paidLink() with it. */
const PL_PLACED = ['draw'];

function plLoad() {
  if (plState !== 'idle') return;
  plState = 'loading';
  fetch('data/paid_links.json', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error('Paid links unavailable'); return r.json(); })
    .then(j => {
      PL = { links: j && Array.isArray(j.links) ? j.links : [] };
      plState = 'ready';
      /* Only redraw when there is something new to show; with the shipped empty file nothing changes. */
      if (plShown().length && typeof render === 'function' && (tab === 'money' || tab === 'seasons')) render();
    })
    .catch(() => { PL = { links: [] }; plState = 'failed'; });
}

/* Only https:// links are ever drawn. */
const plOk = l => !!l && typeof l.url === 'string' && /^https:\/\//i.test(l.url) && typeof l.label === 'string' && l.label !== '' && typeof l.company === 'string' && l.company !== '';

/* The links that would be drawn somewhere today. */
const plFor = slot => PL ? PL.links.find(x => plOk(x) && x.slot === slot) : undefined;
function plShown() {
  return PL_PLACED.map(plFor).filter(Boolean);
}

function paidLink(slot) {
  if (plState === 'idle') plLoad();
  if (!PL) return '';
  const l = plFor(slot);
  if (!l) return '';
  return `<p class="fine paidlink"><b>Paid link</b> &middot; <a href="${esc(l.url)}" target="_blank" rel="sponsored noopener">${esc(l.label)}</a>. Ranger Hawk earns a commission if you join or buy through it.</p>`;
}

/* ---------------------------------------------------------- visitor count --- */
/* No third-party script is loaded. When COUNTER_CODE is set the app sends its own tiny
   request to GoatCounter's documented /count pixel endpoint: p is the path, r the
   referrer, rnd a cache buster (https://www.goatcounter.com/help/pixel). One request per
   screen per app open, only while online, and only the screen name: never typed text,
   coordinates, the trip plan or any stored value. A failure is silent. */
const siteSeen = new Set();
let siteFirst = true;
function siteCount(screen) {
  try {
    if (COUNTER_CODE === '' || !/^[a-z0-9-]+$/i.test(COUNTER_CODE)) return;
    if (!screen || !navigator.onLine || siteSeen.has(screen)) return;
    siteSeen.add(screen);
    let u = 'https://' + COUNTER_CODE + '.goatcounter.com/count?p=' + encodeURIComponent('/screen/' + screen)
      + '&rnd=' + Math.random().toString(36).slice(2);
    if (siteFirst) {
      siteFirst = false;
      if (document.referrer) u += '&r=' + encodeURIComponent(document.referrer);
    }
    new Image().src = u;
  } catch (e) { /* counting never breaks the app */ }
}

/* ----------------------------------------------------------------- screens --- */
function vPrivacy() {
  const counted = COUNTER_CODE === ''
    ? 'Ranger Hawk does not count visitors today. If that changes, this page will say what is counted.'
    : 'While you are online, the app tells GoatCounter, a visitor-counting service, which screen was opened, for example Fish, and on first open the address of the page that linked you here. GoatCounter also sees your browser type, operating system, language and the country your connection comes from. It sets no cookie and says it does not store IP addresses. What you type and where you are never go to it.';
  return `<div class="card"><div class="card-b"><p class="note">Ranger Hawk has no accounts, no ads and no cookies. Almost everything you do in it stays on your phone. This page lists what is kept there, and the few things that leave.</p></div></div>

  <div class="sec-title">Kept on your phone</div><div class="card"><div class="card-b priv">
    <p class="note">These are saved in this browser on this device so the app works without a signal. Ranger Hawk has no server that receives them and cannot see them.</p>
    <ul>
      <li>Your home choice, vehicle, map settings, last map view and the Fish list you last used</li>
      <li>Your draw points</li>
      <li>Your trip plan: your name, where you are going and when you are due back, who is with you, your vehicle, your notes, your contact's name and number, and your truck pin</li>
      <li>Your trail camera sites and the photos you add</li>
      <li>The forecast address for each place you have opened, so forecasts load faster</li>
      <li>The app itself and the offline map, so they open without a signal</li>
    </ul>
    <p class="note">Clearing this site's data in your phone's settings erases all of it. Ranger Hawk keeps no copy.</p>
  </div></div>

  <div class="sec-title">Your location</div><div class="card"><div class="card-b">
    <p class="note">When you use Where am I, the locate button on the map, Back to the truck, a truck or camera pin, or a search near you, your phone works out where you are and the app uses it on the phone. The app never sends your location to Ranger Hawk or to any online service. It leaves the phone only if you tap Text my spot, or text your trip plan, which carries your truck pin. Both go by text message to the contact you chose.</p>
  </div></div>

  <div class="sec-title">What leaves your phone</div><div class="card"><div class="card-b priv">
    <ul>
      <li><b>Loading the app.</b> The files come from rangerhawk.com, which is hosted on GitHub Pages. GitHub logs the IP address of every visitor for security. If the map or terrain is not saved yet, the pieces for the area on screen come from there too.</li>
      <li><b>Fonts.</b> The lettering is served from rangerhawk.com itself, along with the rest of the app. Nothing is loaded from Google or any other font service.</li>
      <li><b>Forecasts.</b> When you open a place while online, the app asks the National Weather Service for the forecast there. It sends the coordinates of the place you tapped, not your own.</li>
      <li><b>Road cameras.</b> Road camera pictures, when the app shows them, load from the camera addresses the Utah Department of Transportation publishes.</li>
      <li><b>Links you tap.</b> Directions open in Apple Maps with the place's coordinates. Agency pages and other sites open in your browser. Once you leave, that site's own privacy rules apply.</li>
      <li><b>Your trip plan and your spot.</b> They leave the phone only if you tap to text them, and then they go through your own messages app to the contact you chose.</li>
    </ul>
  </div></div>

  <div class="sec-title">Counting visitors</div><div class="card"><div class="card-b">
    <p class="note">${counted}</p>
  </div></div>

  <div class="sec-title">Paid links</div><div class="card"><div class="card-b">
    <p class="note">A link that pays Ranger Hawk is marked Paid link beside it. If you tap one, that company learns you came from Ranger Hawk. See How Ranger Hawk makes money in the Menu.</p>
  </div></div>

  <p class="fine">Last changed 2 October 2026. Questions or corrections: open an issue on <a href="https://github.com/Axis174/ranger-hawk/issues" target="_blank" rel="noopener">the project's GitHub page</a>.</p>`;
}

function vMoney() {
  if (plState === 'idle') plLoad();
  const names = [];
  plShown().forEach(l => { if (l.company && names.indexOf(l.company) < 0) names.push(l.company); });
  const today = names.length ? names.map(esc).join(', ') : 'none.';
  return `<div class="card"><div class="card-b"><p class="note">Today it makes none. The app is free, with no ads and no accounts.</p></div></div>

  <div class="sec-title">What stays free</div><div class="card"><div class="card-b">
    <p class="note">The rules. Seasons, limits, boundaries and the agencies' own wording are never sold and never sit behind a sign-up.</p>
  </div></div>

  <div class="sec-title">How it may earn later</div>
  <div class="card"><div class="card-b">
    <p class="note"><strong>Paid links</strong></p>
    <p class="note">Some links to other companies' products may pay Ranger Hawk a commission if you join or buy through them. Each one is marked Paid link beside the link. It costs you nothing extra. A paid link never changes what the app says about a rule, a season or a place.</p>
    <p class="note">Paid links in the app today: ${today}</p>
  </div></div>
  <div class="card"><div class="card-b">
    <p class="note"><strong>A directory of outfitters and guides</strong></p>
    <p class="note">Ranger Hawk plans a directory of outfitters and guides. Outfitters may later pay a flat yearly fee to be listed. Paying never moves a listing up a list or changes how it is described. Ranger Hawk takes no cut of a hunt or trip and does not handle bookings or payments.</p>
  </div></div>

  <div class="sec-title">What Ranger Hawk is not</div><div class="card"><div class="card-b">
    <p class="note">Ranger Hawk is an independent app. It is not part of, or endorsed by, the Utah Division of Wildlife Resources or any other agency. It shows the agencies' words and points to their pages. It is not legal advice: confirm with the agency before you hunt or fish.</p>
  </div></div>`;
}
