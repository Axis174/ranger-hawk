/* Ranger Hawk - trip plan and exit plan. The offline half of a safety feature.
   Before you lose signal: write where you are going, when you will be back and
   who to tell; pin the truck; send the plan by text. In the field, with no
   signal: bearing and distance back to the truck, the exact spot to read to
   Search and Rescue, and a loud overdue warning if the app is opened after the
   back-by time. What this CANNOT do without a server: alert anyone if the phone
   never gets signal again. The plan text tells the contact what to do instead.
   Loaded after app.js; shares its globals. */
'use strict';

let TRIP = null;
try { TRIP = JSON.parse(localStorage.getItem('ha.trip') || 'null'); } catch (e) { /* private mode */ }
const tripSave = () => { try { if (TRIP) localStorage.setItem('ha.trip', JSON.stringify(TRIP)); else localStorage.removeItem('ha.trip'); } catch (e) { /* private mode */ } };
const tripLocal = iso => iso ? new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const tripOverdue = () => TRIP && TRIP.back && Date.now() > Date.parse(TRIP.back);
const dms = (v, pos, neg) => { const a = Math.abs(v), d = Math.floor(a), m = ((a - d) * 60); return `${d}° ${m.toFixed(3)}' ${v >= 0 ? pos : neg}`; };
function bearing(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180, y = Math.sin((bLon - aLon) * r) * Math.cos(bLat * r), x = Math.cos(aLat * r) * Math.sin(bLat * r) - Math.sin(aLat * r) * Math.cos(bLat * r) * Math.cos((bLon - aLon) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
const compass = b => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(b / 22.5) % 16];
/* The Search and Rescue line is read out loud, so spell the direction. */
const SPOKEN = { N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast', E: 'east', ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast',
  S: 'south', SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest', W: 'west', WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest' };

function tripText() {
  const t = TRIP, L = [];
  L.push(`HUNT TRIP PLAN - ${t.name || 'me'}`);
  L.push(`Where: ${t.where || '(not given)'}${t.unit ? ' (' + t.unit + ')' : ''}`);
  if (t.truck) L.push(`Truck parked at: ${t.truck.lat.toFixed(5)}, ${t.truck.lon.toFixed(5)}${t.vehicle ? ' - ' + t.vehicle : ''}`);
  L.push(`Out: ${tripLocal(t.out)}. BACK BY: ${tripLocal(t.back)}.`);
  if (t.party) L.push(`With: ${t.party}`);
  if (t.notes) L.push(`Notes: ${t.notes}`);
  L.push(`If you have not heard from me by ${tripLocal(t.back)}, and my phone does not answer, call the county sheriff (Utah: 911 and ask for Search and Rescue) and give them this message. My phone may have no signal where I am.`);
  L.push('Sent from Ranger Hawk (rangerhawk.com).');
  return L.join('\n');
}
function cardTrip() {
  if (!TRIP) return `<div class="sec-title">Trip plan</div><div class="card"><p class="fine">Tell someone where you are going and when you will be back, before you lose signal. Pin the truck so the app can point you back to it.</p>
    <div class="acts" style="padding:0 14px 14px"><button class="btn" data-trip="new">Make a trip plan</button></div></div>`;
  const od = tripOverdue();
  return `<div class="sec-title">Trip plan${od ? ' &middot; OVERDUE' : ''}</div><div class="card"${od ? ' style="border:2px solid var(--crit)"' : ''}>
    ${od ? `<div class="warnbox" style="margin:12px 14px 0;border-left-color:var(--crit)"><b>You are past your back-by time (${esc(tripLocal(TRIP.back))}).</b> If you are fine, tell your contact now so nobody calls the sheriff. If you are not, read the spot below to them.</div>` : ''}
    <div class="stats">
      <div class="stat"><div class="k">Back by</div><div class="v" style="font-size:12px">${esc(tripLocal(TRIP.back))}</div></div>
      <div class="stat"><div class="k">Contact</div><div class="v" style="font-size:12px">${esc(TRIP.contact || '--')}</div></div>
      <div class="stat"><div class="k">Truck</div><div class="v" style="font-size:12px">${TRIP.truck ? 'pinned' : 'not pinned'}</div></div>
      <div class="stat"><div class="k">Sent</div><div class="v" style="font-size:12px">${TRIP.sent ? esc(tripLocal(TRIP.sent)) : 'not yet'}</div></div>
    </div>
    <div class="acts" style="padding:12px 14px 14px">
      ${TRIP.phone ? `<a class="btn${od ? '' : ' ghost'}" href="sms:${esc(TRIP.phone)}?&body=${encodeURIComponent(od ? "I'm OK, running late. Back-by was " + tripLocal(TRIP.back) + '. New ETA: ' : tripText())}" data-trip="sent">${od ? 'Text: I\'m OK, running late' : 'Send plan by text'}</a>` : ''}
      <button class="btn ghost" data-trip="back">Back to truck &middot; where am I</button>
      <button class="btn ghost" data-trip="edit">Edit</button>
      <button class="btn ghost" data-trip="done">I'm back</button>
    </div></div>`;
}
function tripForm() {
  const t = TRIP || {}, p = n => String(n).padStart(2, '0'), now = new Date();
  const dflt = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  const back = t.back ? dflt(new Date(t.back)) : dflt(new Date(now.getTime() + 10 * 3600000));
  openSheet(`<h3>Trip plan</h3><p class="where">Fill this in where you still have signal, then send it.</p>
    <div class="camform">
      <label>Your name<input id="tp-name" value="${esc(t.name || '')}" placeholder="Pete"></label>
      <label>Where you are going<input id="tp-where" value="${esc(t.where || '')}" placeholder="Soapstone Basin, north of SR-35, RZR from the cabin"></label>
      <label>Back by<input id="tp-back" type="datetime-local" value="${back}"></label>
      <label>Contact name<input id="tp-contact" value="${esc(t.contact || '')}" placeholder="Who gets the plan"></label>
      <label>Contact phone<input id="tp-phone" type="tel" value="${esc(t.phone || '')}" placeholder="801 555 0100"></label>
      <label>Vehicle<input id="tp-vehicle" value="${esc(t.vehicle || '')}" placeholder="White F-150, Utah plate ..."></label>
      <label>Who is with you<input id="tp-party" value="${esc(t.party || '')}" placeholder="Alone / Haylee"></label>
      <label>Notes<input id="tp-notes" value="${esc(t.notes || '')}" placeholder="Orange vest, blue pack, inReach on"></label>
    </div>
    <div class="acts"><button class="btn" data-trip="save">Save plan</button></div>
    <p class="fine" style="padding:10px 16px">The plan stays on this phone. Sending it is a normal text message from your phone to your contact; nothing goes through the app. <b>With no signal the app cannot alert anyone for you</b> - that is why the plan tells your contact what to do if you are late.</p>`);
}
async function tripBack() {
  openSheet('<h3>Back to truck</h3><p class="where">Getting a GPS fix. Works with no signal.</p>');
  if (!UNITS) { try { const j = await (await fetch('data/' + STATE + '/units_geo.json')).json(); UNITS = j && j.units ? j.units : null; } catch (e) { /* offline and never cached */ } }
  if (!navigator.geolocation) { openSheet('<h3>Back to truck</h3><p class="where">This phone is not sharing location with the app.</p>'); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    const lat = pos.coords.latitude, lon = pos.coords.longitude, tr = TRIP && TRIP.truck;
    const un = UNITS ? unitsAt(lon, lat).map(u => esc(u.n)) : [];
    /* Unit names carry their own commas ("Wasatch Mtns, East"), so three or more of them
       comma-joined ran together into one unintelligible string in the sentence Pete is told
       to read to a dispatcher. Semicolons cannot collide with what is inside a name. */
    const units = un.length > 2 ? un.slice(0, -1).join('; ') + '; and ' + un[un.length - 1]
      : un.length === 2 ? un[0] + ' and ' + un[1] : un[0] || '';
    const near = DB.birds.map(p => ({ p, mi: miles(lat, lon, p.lat, p.lon) })).sort((a, b) => a.mi - b.mi)[0];
    /* A bare mileage to a landmark sounds like "nearby", so give the direction -
       and say nothing at all past 25 miles. The access points are clustered in
       the north, so the closest one to a southern hunt can be 100 miles off, and
       naming it would point Search and Rescue at the wrong end of the state. */
    const land = near && near.mi <= 25 ? `, about ${near.mi.toFixed(1)} miles ${SPOKEN[compass(bearing(near.p.lat, near.p.lon, lat, lon))]} of ${esc(near.p.name)}` : '';
    let truck = '<p class="fine" style="padding:8px 16px 0">No truck pinned. Pin it next time before you walk in.</p>';
    if (tr) { const mi = miles(lat, lon, tr.lat, tr.lon), b = bearing(lat, lon, tr.lat, tr.lon); truck = `<div class="stats"><div class="stat"><div class="k">Truck is</div><div class="v">${mi < 0.2 ? Math.round(mi * 5280) + ' ft' : mi.toFixed(2) + ' mi'}</div></div><div class="stat"><div class="k">Heading</div><div class="v">${Math.round(b)}&deg; ${compass(b)}</div></div><div class="stat"><div class="k">Elevation change</div><div class="v" style="font-size:12px">${pos.coords.altitude != null && tr.alt != null ? Math.round((tr.alt - pos.coords.altitude) * 3.28084) + ' ft' : '--'}</div></div></div><p class="fine" style="padding:6px 16px 0">Straight line, not a route. Hold the phone flat, turn until the compass reads ${Math.round(b)}&deg;, and walk. Cliffs and drainages are on the Map tab.</p>`; }
    openSheet(`<h3>Where I am</h3>
      <p class="where mono" style="font-size:15px">${lat.toFixed(5)}, ${lon.toFixed(5)}</p>
      <p class="where mono">${esc(dms(lat, 'N', 'S'))} &nbsp; ${esc(dms(lon, 'E', 'W'))} &middot; &plusmn;${Math.round(pos.coords.accuracy)} m${pos.coords.altitude != null ? ' &middot; ' + Math.round(pos.coords.altitude * 3.28084) + ' ft' : ''}</p>
      <div class="warnbox" style="margin:8px 16px 0"><b>If you call for help, read this:</b> "I am at ${lat.toFixed(5)} north, ${Math.abs(lon).toFixed(5)} west${units ? ', in the ' + units + ' hunt unit' + (un.length > 1 ? 's' : '') : ''}${land}." Then your condition, your vehicle, and who is with you.</div>
      ${truck}
      <div class="acts"><button class="btn ghost" data-copy="${lat.toFixed(5)}, ${lon.toFixed(5)}">Copy coordinates</button>${TRIP && TRIP.phone ? `<a class="btn ghost" href="sms:${esc(TRIP.phone)}?&body=${encodeURIComponent('My location: ' + lat.toFixed(5) + ', ' + lon.toFixed(5) + ' (accuracy ' + Math.round(pos.coords.accuracy) + ' m). ')}">Text my spot</a>` : ''}<button class="btn ghost" data-trip="pin">Pin truck here</button></div>
      <p class="fine" style="padding:10px 16px">Texts only go out when the phone finds signal; they queue until then. iPhone 14 and later can also send an Emergency SOS by satellite from Settings when there is no signal at all.</p>`);
  }, err => openSheet(`<h3>Where I am</h3><p class="where">No GPS fix: ${esc(err.message || 'refused')}.</p>`), { enableHighAccuracy: true, timeout: 25000, maximumAge: 15000 });
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-trip]'); if (!t) return;
  const a = t.dataset.trip;
  if (a === 'new' || a === 'edit') { tripForm(); return; }
  if (a === 'save') {
    const v = id => ($(id) || {}).value || '';
    TRIP = Object.assign(TRIP || { out: new Date().toISOString() }, { name: v('tp-name').trim(), where: v('tp-where').trim(), back: v('tp-back') ? new Date(v('tp-back')).toISOString() : null, contact: v('tp-contact').trim(), phone: v('tp-phone').replace(/[^\d+]/g, ''), vehicle: v('tp-vehicle').trim(), party: v('tp-party').trim(), notes: v('tp-notes').trim() });
    if (!TRIP.back) { $('tp-back').focus(); return; }
    tripSave(); closeSheet(); render(); return;
  }
  if (a === 'sent') { if (TRIP) { TRIP.sent = new Date().toISOString(); tripSave(); setTimeout(render, 500); } return; }   // the sms: link still opens
  if (a === 'done') { if (confirm('Clear this trip plan? Text your contact that you are back first.')) { TRIP = null; tripSave(); render(); } return; }
  if (a === 'back') { tripBack(); return; }
  if (a === 'pin') {
    navigator.geolocation.getCurrentPosition(pos => { TRIP = TRIP || { out: new Date().toISOString(), back: null }; TRIP.truck = { lat: pos.coords.latitude, lon: pos.coords.longitude, alt: pos.coords.altitude, at: new Date().toISOString() }; tripSave(); closeSheet(); render(); },
      () => {}, { enableHighAccuracy: true, timeout: 20000 });
  }
});
