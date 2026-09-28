/* Offline-first service worker.

   Shell assets use stale-while-revalidate: the cached copy is served
   immediately (fast, and works with no signal) while a fresh copy is fetched
   in the background for next time. A plain cache-first shell would pin an
   installed phone to whatever CSS it first downloaded, so a fix would never
   arrive - that is a real failure mode, not a theoretical one.

   Data is network-first with a cache fallback: a live refresh wins when there
   is signal, and the last good copy is there when there is none. */
const VERSION = 'ranger-hawk-v24';
const SHELL = [
  './', './index.html', './app.js', './cams.js', './finder.js', './fishing.js', './trip.js', './roads.js', './styles.css', './data/cam_rules.json', './data/hunt_units_2026.json', './data/landowner_tags.json',
  './manifest.webmanifest', './icons/rangerhawk-wordmark.svg', './icons/icon-192.png', './icons/icon-512.png',
  './data/bird_access.json', './data/seasons.json', './data/config.json',
  './vendor/suncalc.js', './data/lake_level.json', './data/units_geo.json', './data/snow.json', './data/draw_odds.json', './data/udot.json',
  './data/fishing_rules.json', './data/fishing_places.json', './data/fishing_notices.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(new Request(u, {cache: 'reload'})))))
      .then(() => self.skipWaiting())
  );
});

// The offline map lives in its own cache so an app update never throws away a
// 65 MB download.
const MAPS = 'ranger-hawk-maps';
const mapBlobs = {};

// PMTiles reads the map files with byte-range requests. Answer them from the
// saved copy when there is one; otherwise let the network handle it.
async function mapRange(req) {
  const url = req.url.split('?')[0];
  if (!mapBlobs[url]) {
    const hit = await (await caches.open(MAPS)).match(url);
    if (!hit) return fetch(req);
    mapBlobs[url] = await hit.blob();
  }
  const blob = mapBlobs[url], size = blob.size;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.get('range') || '');
  if (!m) return new Response(blob, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  const start = +m[1], end = m[2] ? Math.min(+m[2], size - 1) : size - 1;
  return new Response(blob.slice(start, end + 1), { status: 206, headers: {
    'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
}

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== MAPS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.endsWith('.pmtiles')) { e.respondWith(mapRange(req)); return; }

  // Data: network first, fall back to the last good copy.
  if (url.pathname.includes('/data/')) {
    e.respondWith(
      fetch(req).then(r => {
        if (r && r.ok) {
          const copy = r.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return r;
      }).catch(() => caches.match(req).then(r => r || new Response(
        JSON.stringify({offline: true}), {headers: {'Content-Type': 'application/json'}})))
    );
    return;
  }

  // Shell: stale-while-revalidate.
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(r => {
        if (r && r.ok) {
          const copy = r.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return r;
      }).catch(() => hit || caches.match('./index.html'));
      return hit || net;
    })
  );
});
