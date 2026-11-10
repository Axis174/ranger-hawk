#!/usr/bin/env node
/* Checks docs/site.js: the paid-link slot, the visitor-count switch, and the Privacy
   and "How Ranger Hawk makes money" screens. It loads the real docs/site.js with the
   browser stubbed out. Run with:

       node scraper/test_site.js
*/
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'docs', 'site.js'), 'utf8');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* One page. code is the COUNTER_CODE to test with ('' is off; the shipped value is the live site code). */
function page(code, opts) {
  opts = opts || {};
  const sent = [], renders = [], fetches = [];
  class FakeImage { set src(v) { sent.push(v); } }
  const box = {
    console, JSON, Object, Array, String, Number, RegExp, Promise, Set, Math, encodeURIComponent, STATE: 'ut',
    esc, tab: 'today', render() { renders.push(box.tab); },
    navigator: { onLine: opts.online !== false },
    document: { referrer: opts.referrer == null ? '' : opts.referrer },
    Image: FakeImage,
    fetch(url) {
      fetches.push(String(url));
      if (opts.fetch) return opts.fetch(url);
      return Promise.reject(new Error('no network in tests'));
    }
  };
  vm.createContext(box);
  vm.runInContext(source.replace(/const COUNTER_CODE = '[^']*';/, 'const COUNTER_CODE = ' + JSON.stringify(code) + ';') +
    '\n;this.T = { paidLink, vPrivacy, vMoney, siteCount, siteEvent, plLoad, plShown, placed: () => PL_PLACED.slice(),' +
    ' setLinks: l => { PL = { links: l }; plState = "ready"; }, state: () => plState };', box);
  return { T: box.T, box, sent, renders, fetches };
}

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail ? '\n       got ' + detail : ''));
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const EMOJI = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u;
const ENTRY = { slot: 'draw', company: 'Example Co', label: 'Draw odds and unit research at Example Co', url: 'https://example.com/join?a=1&b=2' };

/* docs/sw.js in a scratch context, with an in-memory CacheStorage and a network that can fail
   on chosen files. It follows the browser's rules: activate runs only after install's waitUntil
   fulfils; Cache.add and addAll reject a response that is not OK; addAll rejects a list that
   names a file twice and stores nothing unless every file came back OK; caches.match looks
   through the caches in the order they were made. */
const SW_SRC = fs.readFileSync(path.join(ROOT, 'docs', 'sw.js'), 'utf8');
const SW_ORIGIN = 'https://rangerhawk.com';
const swUrl = u => new URL(typeof u === 'string' ? u : u.url, SW_ORIGIN + '/sw.js').href;
class SwResponse {
  constructor(body, status) { this.body = body; this.status = status || 200; this.ok = this.status >= 200 && this.status < 300; }
  clone() { return new SwResponse(this.body, this.status); }
}
class SwRequest { constructor(u, init) { this.url = swUrl(u); this.method = 'GET'; this.cache = init && init.cache; this.headers = { get: () => null }; } }
/* Every file answers with tag + its URL, except: status maps a file to an error status, drop
   lists files whose download breaks off, and offline fails everything. */
function swNetwork(tag, opts) {
  opts = opts || {};
  const status = {}, drop = new Set((opts.drop || []).map(swUrl));
  for (const [u, s] of Object.entries(opts.status || {})) status[swUrl(u)] = s;
  return async r => {
    const u = swUrl(r);
    if (opts.offline || drop.has(u)) throw new TypeError('Failed to fetch');
    return new SwResponse(status[u] ? 'error page' : tag + ':' + u, status[u]);
  };
}
function swCaches(initial) {
  const store = new Map();
  for (const [name, entries] of Object.entries(initial)) store.set(name, new Map(Object.entries(entries).map(([u, b]) => [swUrl(u), new SwResponse(b)])));
  let net = null;
  const cache = m => ({
    async match(r) { return m.get(swUrl(r)); },
    async put(r, resp) { m.set(swUrl(r), resp); },
    async delete(r) { return m.delete(swUrl(r)); },
    async add(r) { return this.addAll([r]); },
    async addAll(rs) {
      const urls = rs.map(swUrl);
      if (new Set(urls).size !== urls.length) throw new Error('InvalidStateError: the same request twice');
      const got = await Promise.all(rs.map(r => net(r)));
      if (got.some(resp => !resp.ok)) throw new TypeError('Request failed');
      got.forEach((resp, i) => m.set(urls[i], resp));
    }
  });
  return {
    store, useNetwork(f) { net = f; },
    async open(name) { if (!store.has(name)) store.set(name, new Map()); return cache(store.get(name)); },
    async keys() { return [...store.keys()]; },
    async has(name) { return store.has(name); },
    async delete(name) { return store.delete(name); },
    async match(r) { const u = swUrl(r); for (const m of store.values()) if (m.has(u)) return m.get(u); }
  };
}
/* Load a worker into a fresh context; returns its handlers, its SHELL, and how often it called skipWaiting and claim. */
function swLoad(src, caches, network) {
  caches.useNetwork(network);
  const handlers = {}, calls = { skipWaiting: 0, claim: 0 };
  const self = {
    addEventListener: (t, f) => { handlers[t] = f; },
    skipWaiting: () => { calls.skipWaiting++; return Promise.resolve(); },
    clients: { claim: () => { calls.claim++; return Promise.resolve(); } }
  };
  const box = { self, caches, fetch: network, Request: SwRequest, Response: SwResponse, URL, location: { origin: SW_ORIGIN }, Promise, JSON, Object, Array, String, Number, RegExp, Math, console };
  vm.createContext(box);
  vm.runInContext(src + '\n;this.__shell = SHELL;', box);
  return { handlers, calls, shell: [...box.__shell] };
}
const swFire = async (w, type) => { let p; w.handlers[type]({ waitUntil: x => { p = x; } }); await p; };
/* What the browser does when it finds a changed sw.js: install, and activate only if install worked. */
async function swUpdate(src, caches, network) {
  const w = swLoad(src, caches, network);
  try { await swFire(w, 'install'); } catch (err) { return { w, installed: false, err }; }
  await swFire(w, 'activate');
  return { w, installed: true };
}
/* A page asks the worker for a file; returns the body it answers with. */
async function swGet(w, u) {
  let p;
  w.handlers.fetch({ request: new SwRequest(u), respondWith: x => { p = x; } });
  const r = await p;
  return r && r.body;
}
const swDump = caches => Object.fromEntries([...caches.store.entries()].map(([n, m]) => [n, Object.fromEntries([...m.entries()].map(([u, r]) => [u, r.body]).sort())]));

async function run() {
  /* ---- paidLink */
  {
    const { T } = page('');
    T.setLinks([]);
    ok('empty list: nothing', T.paidLink('draw') === '');
    T.setLinks([ENTRY]);
    ok('unknown slot: nothing', T.paidLink('fish') === '');
    ok('missing slot name: nothing', T.paidLink(undefined) === '');
    for (const bad of ['http://example.com/', 'javascript:alert(1)', '//example.com/', 'example.com', 'ftp://example.com/', '', null, 5]) {
      T.setLinks([Object.assign({}, ENTRY, { url: bad })]);
      ok('non-https url is not drawn: ' + JSON.stringify(bad), T.paidLink('draw') === '');
    }
    T.setLinks([Object.assign({}, ENTRY, { label: '' })]);
    ok('a link with no label is not drawn', T.paidLink('draw') === '');
    T.setLinks([ENTRY]);
    const want = '<p class="fine paidlink"><b>Paid link</b> &middot; <a href="https://example.com/join?a=1&amp;b=2" target="_blank" rel="sponsored noopener">Draw odds and unit research at Example Co</a>. Ranger Hawk earns a commission if you join or buy through it. Tapping lets that site set a cookie so Ranger Hawk is credited.</p>';
    ok('a fixture entry gives the exact marked string', T.paidLink('draw') === want, T.paidLink('draw'));
    T.setLinks([Object.assign({}, ENTRY, { label: 'A <b>big</b> deal "now"', url: 'https://example.com/"x"' })]);
    const h = T.paidLink('draw');
    ok('< in a label is escaped', h.indexOf('<b>big') < 0 && h.indexOf('A &lt;b&gt;big&lt;/b&gt; deal &quot;now&quot;') > 0, h);
    ok('a quote in a url cannot end the attribute', h.indexOf('href="https://example.com/&quot;x&quot;"') > 0, h);
    ok('rel is always sponsored', /rel="sponsored noopener"/.test(h));
  }

  /* ---- the file loads like contacts.js does, and the shipped file is empty */
  {
    const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data', 'ut', 'paid_links.json'), 'utf8'));
    ok('the shipped paid_links.json is { links: [] }', Array.isArray(shipped.links) && shipped.links.length === 0 && Object.keys(shipped).length === 1);
    const { T, fetches } = page('', { fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(shipped) }) });
    ok('first call draws nothing', T.paidLink('draw') === '');
    await settle();
    ok('it fetched data/ut/paid_links.json once', fetches.length === 1 && fetches[0] === 'data/ut/paid_links.json', fetches.join(','));
    ok('and is ready', T.state() === 'ready');
    T.paidLink('draw');
    ok('it does not fetch again', fetches.length === 1);

    const withOne = page('', { fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ links: [ENTRY] }) }) });
    withOne.box.tab = 'seasons';
    ok('before the file arrives nothing is drawn', withOne.T.paidLink('draw') === '');
    await settle();
    ok('once it arrives a link is drawn', withOne.T.paidLink('draw') !== '');
    ok('and the open screen is redrawn once', withOne.renders.length === 1, String(withOne.renders.length));

    const FX_ENTRY2 = { slot: 'forecast', company: 'Example Gear Co', label: 'Gaiters at Example Gear Co', url: 'https://example.com/g' };
    const fxOpen = page('', { fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ links: [FX_ENTRY2] }) }) });
    fxOpen.box.tab = 'forecast';
    ok('forecast tab open, before the file arrives nothing is drawn', fxOpen.T.paidLink('forecast') === '');
    await settle();
    ok('once a forecast link arrives the open forecast screen is redrawn once', fxOpen.T.paidLink('forecast') !== '' && fxOpen.renders.length === 1, String(fxOpen.renders.length));
    const other = page('', { fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ links: [FX_ENTRY2] }) }) });
    other.box.tab = 'fish'; other.T.paidLink('forecast'); await settle();
    ok('a screen with no slot is not redrawn when a link arrives', other.renders.length === 0, String(other.renders.length));

    const quiet = page('', { fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ links: [] }) }) });
    quiet.box.tab = 'seasons'; quiet.T.paidLink('draw'); await settle();
    ok('an empty file redraws nothing', quiet.renders.length === 0);

    const failed = page('', { fetch: () => Promise.resolve({ ok: false, status: 404 }) });
    failed.T.paidLink('draw'); await settle();
    ok('a failed fetch is quiet and draws nothing', failed.T.state() === 'failed' && failed.T.paidLink('draw') === '');

    const offlineStub = page('', { fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ offline: true }) }) });
    offlineStub.T.paidLink('draw'); await settle();
    ok('the service worker offline stub counts as empty', offlineStub.T.paidLink('draw') === '' && offlineStub.T.state() === 'ready');
  }

  /* ---- the visitor count */
  {
    const off = page('', { referrer: 'https://example.org/' });
    off.T.siteCount('fish'); off.T.siteCount('today');
    ok('empty code: nothing is sent', off.sent.length === 0);

    const on = page('abc', { referrer: 'https://example.org/page?x=1' });
    on.T.siteCount('today');
    ok('a code sends one request', on.sent.length === 1, JSON.stringify(on.sent));
    const u = new URL(on.sent[0]);
    ok('to the GoatCounter count endpoint for that code', u.origin === 'https://abc.goatcounter.com' && u.pathname === '/count', on.sent[0]);
    ok('with the screen name as the path', u.searchParams.get('p') === '/screen/today');
    ok('and a random rnd', /^[a-z0-9]+$/.test(u.searchParams.get('rnd') || ''));
    ok('the first request carries the referrer', u.searchParams.get('r') === 'https://example.org/page?x=1');
    ok('and nothing else', [...u.searchParams.keys()].sort().join(',') === 'p,r,rnd', [...u.searchParams.keys()].join(','));
    on.T.siteCount('fish');
    const u2 = new URL(on.sent[1]);
    ok('the second screen has no referrer', u2.searchParams.get('r') === null && u2.searchParams.get('p') === '/screen/fish');
    on.T.siteCount('fish'); on.T.siteCount('today');
    ok('each screen is counted once per app open', on.sent.length === 2, String(on.sent.length));

    const blank = page('abc', { referrer: '' });
    blank.T.siteCount('map');
    ok('an empty referrer is not sent', new URL(blank.sent[0]).searchParams.get('r') === null);

    const offline = page('abc', { online: false, referrer: 'https://example.org/' });
    offline.T.siteCount('map');
    ok('offline: nothing is sent', offline.sent.length === 0);
    offline.box.navigator.onLine = true;
    offline.T.siteCount('map');
    ok('online later: the screen and the referrer are still sent', offline.sent.length === 1 && new URL(offline.sent[0]).searchParams.get('r') === 'https://example.org/');

    const odd = page('a.b/c?x');
    odd.T.siteCount('map');
    ok('a code that is not a plain site code sends nothing', odd.sent.length === 0);

    /* events: the same pixel with e=true, by name alone */
    const ev = page('abc', { referrer: 'https://example.org/' });
    ev.T.siteEvent('forecast-why');
    const e0 = ev.sent.length === 1 ? new URL(ev.sent[0]) : null;
    ok('an event sends one request with e=true, p=/event/<name>, rnd and nothing else, no referrer', e0 && e0.origin === 'https://abc.goatcounter.com' && e0.pathname === '/count' && e0.searchParams.get('e') === 'true' && e0.searchParams.get('p') === '/event/forecast-why' && [...e0.searchParams.keys()].sort().join(',') === 'e,p,rnd', ev.sent.join(' '));
    ev.T.siteEvent('forecast-why'); ev.T.siteEvent('forecast-species-elk'); ev.T.siteEvent('forecast-species-elk');
    ok('each event name is sent once per app open', ev.sent.length === 2 && new URL(ev.sent[1]).searchParams.get('p') === '/event/forecast-species-elk', String(ev.sent.length));
    ev.T.siteCount('forecast');
    ok('the first screen count after events still carries the referrer, and an event never does', ev.sent.length === 3 && new URL(ev.sent[2]).searchParams.get('r') === 'https://example.org/' && new URL(ev.sent[2]).searchParams.get('e') === null);
    ev.T.siteEvent('Bad Name!'); ev.T.siteEvent(''); ev.T.siteEvent('forecast/why'); ev.T.siteEvent(null);
    ok('a name that is not plain lower-case letters, digits and dashes is not sent', ev.sent.length === 3, String(ev.sent.length));
    const evOff = page('');
    evOff.T.siteEvent('forecast-why');
    ok('empty code: no event is sent', evOff.sent.length === 0);
    const evOffline = page('abc', { online: false });
    evOffline.T.siteEvent('forecast-why');
    ok('offline: no event is sent', evOffline.sent.length === 0);
    const evOdd = page('a.b/c?x');
    evOdd.T.siteEvent('forecast-why');
    ok('a code that is not a plain site code sends no event', evOdd.sent.length === 0);

    /* A tag inside an HTML comment is text: no browser fetches or runs it. Comments come out first, so the
       guard reads what a browser would load (2026-11-10, a site-ownership check that sat in a comment). */
    const thirdParty = html => (html.replace(/<!--[\s\S]*?-->/g, '').match(/<script[^>]*src="([^"]+)"/g) || []).filter(t => /src="(https?:)?\/\//.test(t));
    const noScript = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
    ok('no third-party script tag in index.html', thirdParty(noScript).length === 0, thirdParty(noScript).join(' '));
    ok('the guard bites on a live third-party tag, http, https or protocol-relative', thirdParty('<script src="https://x.example/a.js"></script>').length === 1 && thirdParty('<script type="text/javascript" src="http://x.example/a.js"></script>').length === 1 && thirdParty('<script src="//x.example/a.js"></script>').length === 1);
    ok('and passes a tag inside a comment, but not one that follows the comment', thirdParty('<!-- <script src="https://x.example/a.js"></script> -->').length === 0 && thirdParty('<!-- note --><script src="https://x.example/a.js"></script>').length === 1);
  }

  /* ---- Privacy screen */
  {
    const NONE = 'Ranger Hawk does not count visitors today. If that changes, this page will say what is counted.';
    const SET = 'While you are online, the app tells GoatCounter, a visitor-counting service, which screen was opened';
    const a = page('').T.vPrivacy(), b = page('abc').T.vPrivacy();
    ok('code empty: the Privacy screen says it does not count', a.indexOf(NONE) >= 0 && a.indexOf('GoatCounter') < 0);
    ok('code set: the Privacy screen has the GoatCounter paragraph', b.indexOf(SET) >= 0 && b.indexOf(NONE) < 0);
    for (const h of ['Kept on your phone', 'Your location', 'What leaves your phone', 'Counting visitors', 'Paid links']) {
      ok('Privacy has the section "' + h + '"', a.indexOf('<div class="sec-title">' + h + '</div>') >= 0);
    }
    ok('Privacy has the opening note', a.indexOf('Ranger Hawk has no accounts, no ads and no cookies. Almost everything you do in it stays on your phone. This page lists what is kept there, and the few things that leave.') >= 0);
    ok('Privacy lists the six kept items and the six that leave', (a.match(/<li>/g) || []).length === 6 + 6);
    ok('Privacy says how a location can leave', a.indexOf('It leaves the phone only if you tap Text my spot') > 0);
    ok('Privacy says a paid-link tap goes by way of the affiliate network and may set a cookie at the store', /you leave for that company's site, usually by way of the affiliate network that pays Ranger Hawk\. The company, and the network when there is one, learn you came from Ranger Hawk, and their sites may set a cookie so a purchase is credited to Ranger Hawk\. Once you leave, their own privacy rules apply\./.test(a));
    ok('Privacy links the GitHub issues page', a.indexOf('href="https://github.com/Axis174/ranger-hawk/issues" target="_blank" rel="noopener">the project\'s GitHub page</a>') > 0);
    ok('code set: Privacy names the three forecast events by name and says nothing goes with them', /three taps the same way, by name alone: Mule deer, Elk, and Why these factors\. No spot, no coordinates and no unit name go with them\./.test(b), b.slice(b.indexOf('GoatCounter'), b.indexOf('GoatCounter') + 700));
    ok('code empty: Privacy does not mention the events', a.indexOf('Why these factors') < 0 && a.indexOf('three taps') < 0);
    ok('Privacy has no emoji', !EMOJI.test(a) && !EMOJI.test(b));
    ok('Privacy has no script or inline handler', !/<script|onclick=|onerror=/i.test(a));
  }

  /* ---- the snow gauges the hunt forecast reads */
  {
    const snow = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data', 'ut', 'snow.json'), 'utf8'));
    ok('snow.json names its source once, first', typeof snow._source === 'string' && /wcc\.sc\.egov\.usda\.gov/.test(snow._source) && Object.keys(snow)[0] === '_source' && Object.keys(snow).filter(k => k === '_source').length === 1);
    ok('every gauge carries lat and lon inside Utah\'s box, an elevation and a name', Array.isArray(snow.stations) && snow.stations.length >= 1 && snow.stations.every(g => isFinite(g.lat) && isFinite(g.lon) && g.lat >= 37 && g.lat <= 42 && g.lon >= -114.05 && g.lon <= -109.04 && g.elev_ft > 0 && typeof g.name === 'string' && g.name), JSON.stringify((snow.stations || []).map(g => [g.name, g.lat, g.lon, g.elev_ft])));
    const py = fs.readFileSync(path.join(ROOT, 'scraper', 'sources.py'), 'utf8');
    ok('sources.py carries a lat and lon cache for every gauge in the file (a move is a warning in the nightly log, not a red run)', snow.stations.every(g => new RegExp('"' + g.station + '":\\s*\\{[^}]*"lat":\\s*-?[\\d.]+,\\s*"lon":\\s*-?[\\d.]+').test(py)));
    ok('refresh.py warns, and does not fail, when a gauge moves', /::warning title=Snow gauge moved::/.test(fs.readFileSync(path.join(ROOT, 'scraper', 'refresh.py'), 'utf8')));
  }

  /* ---- Money screen */
  {
    const { T } = page('');
    T.setLinks([]);
    const m = T.vMoney();
    for (const h of ['What stays free', 'How it may earn later', 'What Ranger Hawk is not']) {
      ok('Money has the section "' + h + '"', m.indexOf('<div class="sec-title">' + h + '</div>') >= 0);
    }
    ok('Money has the opening note', m.indexOf('Today it makes none. The app is free, with no ads and no accounts.') >= 0);
    ok('Money has both cards', m.indexOf('<strong>Paid links</strong>') >= 0 && m.indexOf('<strong>A directory of outfitters and guides</strong>') >= 0);
    ok('Money says "none" with an empty list', m.indexOf('Paid links in the app today: none.') >= 0, m.slice(m.indexOf('Paid links in the app today')));
    ok('Money has no emoji', !EMOJI.test(m));
    ok('Money says the forecast stays free and that no factor in it is ever an ad', m.indexOf('The rules and the forecast.') >= 0 && m.indexOf('Under the hunt forecast, a paid link may point to in-season gear. It never changes what the forecast says, and no factor in it is ever an ad.') >= 0);
    T.setLinks([Object.assign({}, ENTRY, { company: 'Bad first', url: 'javascript:alert(1)' }), Object.assign({}, ENTRY, { company: 'First <Co>' }), Object.assign({}, ENTRY, { company: 'Second Co', slot: 'draw' }), Object.assign({}, ENTRY, { company: 'Elsewhere', slot: 'nowhere' }), Object.assign({}, ENTRY, { company: 'Bad', url: 'http://x.com' })]);
    const m2 = T.vMoney();
    ok('Money lists only the company whose link is drawn, escaped', m2.indexOf('Paid links in the app today: First &lt;Co&gt;</p>') >= 0, m2.slice(m2.indexOf('Paid links in the app today')));
    ok('and does not list an unplaced slot or a non-https link', m2.indexOf('Elsewhere') < 0 && m2.indexOf('Bad') < 0);
    ok('Money with links has no "none"', m2.indexOf('today: none') < 0);
  }

  /* ---- the forecast slot (added 2026-11-03; empty until a link is filled in) */
  {
    const { T } = page('');
    const FX_ENTRY = { slot: 'forecast', company: 'Example Gear Co', label: 'Gaiters and traction for a snow week at Example Gear Co', url: 'https://example.com/gaiters' };
    T.setLinks([FX_ENTRY]);
    ok('a forecast entry is drawn by the forecast slot and by no other', T.paidLink('forecast') !== '' && T.paidLink('draw') === '');
    ok('the forecast slot is placed, so the money screen lists its company', T.plShown().length === 1 && T.vMoney().indexOf('Paid links in the app today: Example Gear Co</p>') >= 0, T.vMoney().slice(T.vMoney().indexOf('Paid links in the app today')));
    ok('the placed slots are draw and forecast, in that order', JSON.stringify(T.placed()) === '["draw","forecast"]', JSON.stringify(T.placed()));
    T.setLinks([]);
    ok('with the shipped empty file the forecast slot draws nothing', T.paidLink('forecast') === '');
  }

  /* ---- the wiring in the other files */
  {
    const app = fs.readFileSync(path.join(ROOT, 'docs', 'app.js'), 'utf8'), go = fs.readFileSync(path.join(ROOT, 'docs', 'go.js'), 'utf8');
    const idx = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8'), sw = fs.readFileSync(path.join(ROOT, 'docs', 'sw.js'), 'utf8');
    ok('app.js titles: Privacy and How Ranger Hawk makes money', app.indexOf("privacy: 'Privacy', money: 'How Ranger Hawk makes money'") > 0);
    ok('app.js draws the two screens', /privacy: \(typeof vPrivacy/.test(app) && /money: \(typeof vMoney/.test(app));
    ok('app.js counts the screen from render()', /function render\(\) \{\n  if \(typeof siteCount === 'function'\) siteCount\(tab\)/.test(app));
    ok('vDraw puts the paid link after the agency paragraph', /Always confirm at utahdraws\.com before applying\.<\/p>`;\n  if \(typeof paidLink === 'function'\) h \+= paidLink\('draw'\);\n  return h;/.test(app));
    const fx = fs.readFileSync(path.join(ROOT, 'docs', 'forecast.js'), 'utf8');
    ok('vForecast puts the paid link last, after the source line and the Why button', /Why these factors<\/button><\/p>`;\n(?:  \/\*(?:(?!\*\/)[^])*\*\/\n)?  if \(typeof paidLink === 'function'\) \{ const pl = paidLink\('forecast'\); if \(pl\) h \+= `<div class="fx-paid">\$\{pl\}<\/div>`; \}\n  return h;\n\}/.test(fx));
    ok('styles.css lines the forecast paid link up with the source line', /\.fx-paid \.paidlink\{padding-inline:0\}/.test(fs.readFileSync(path.join(ROOT, 'docs', 'styles.css'), 'utf8')));
    ok('forecast.js calls the slot once, so it is never inside a factor row or a card', (fx.match(/paidLink\(/g) || []).length === 1, String((fx.match(/paidLink\(/g) || []).length));
    ok('go.js has the two rows', /tab: 'privacy'/.test(go) && /tab: 'money'/.test(go));
    ok('index.html loads site.js after go.js', idx.indexOf('<script src="go.js"></script>\n<script src="site.js"></script>') > 0);
    ok('sw.js is v46 and lists site.js and paid_links.json', /VERSION = 'ranger-hawk-v46'/.test(sw) && sw.indexOf("'./site.js'") > 0 && sw.indexOf("'./data/ut/paid_links.json'") > 0);
    const scripts = (idx.match(/<script\b[^>]*>/g) || []).filter(t => !/type="application\/ld\+json"/.test(t));   // the structured data in <head> is not an app script
    ok('index.html loads state.js first before app.js and sw.js lists it', scripts[0] === '<script src="state.js">' && scripts.indexOf('<script src="app.js">') > 0 && sw.indexOf("'./state.js'") > 0);
  }

  /* ---- the service worker's shell list. A shell file that is missing, or listed twice,
     fails every install, so no phone would ever take an update. */
  {
    const shell = swLoad(SW_SRC, swCaches({}), swNetwork('x')).shell;
    /* A file, not a folder, with every part of its name in the exact case (GitHub Pages is case-sensitive; a Mac is not). */
    const onDisk = u => {
      const parts = u.replace(/^\.\//, '').replace(/(^|\/)$/, '$1index.html').split('/');
      let dir = path.join(ROOT, 'docs');
      for (const part of parts) {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory() || !fs.readdirSync(dir).includes(part)) return false;
        dir = path.join(dir, part);
      }
      return fs.statSync(dir).isFile();
    };
    ok('the shell names each file once', new Set(shell).size === shell.length, shell.filter((u, i) => shell.indexOf(u) !== i).join());
    ok('every shell file is in docs/', shell.every(onDisk), shell.filter(u => !onDisk(u)).join());
    const pages = fs.readdirSync(path.join(ROOT, 'docs')).filter(d => fs.existsSync(path.join(ROOT, 'docs', d, 'index.html')));
    ok('every website page is in the shell', pages.length >= 5 && pages.every(d => shell.includes('./' + d + '/')), pages.filter(d => !shell.includes('./' + d + '/')).join());
    const linked = new Set();
    for (const dir of [''].concat(pages)) {
      const html = fs.readFileSync(path.join(ROOT, 'docs', dir, 'index.html'), 'utf8');
      for (const tag of html.match(/<(link|script|img)\b[^>]*>/g) || []) {
        const ref = (/\b(?:href|src)="([^"]*)"/.exec(tag) || [])[1];
        if (!ref || /^[a-z]+:|^\/\//i.test(ref) || /\brel="canonical"/.test(tag)) continue;
        linked.add('./' + path.posix.normalize(path.posix.join(dir, ref.split(/[?#]/)[0])));
      }
    }
    ok('every file index.html and the website pages link is in the shell', linked.size > 10 && [...linked].every(u => shell.includes(u)), [...linked].filter(u => !shell.includes(u)).join());
  }

  /* ---- the service worker on an update: a failed shell download leaves the old worker and its
     cache in place, a good update replaces the old cache, and the saved maps survive both. */
  {
    const OLD = 'ranger-hawk-vOLD', NEW = (/const VERSION = '([^']+)'/.exec(SW_SRC) || [])[1];
    const OLD_SRC = SW_SRC.replace(/const VERSION = '[^']+';/, `const VERSION = '${OLD}';`);
    const MAPS = { 'maps/utah.pmtiles': 'PM-utah', 'maps/land.pmtiles': 'PM-land', 'vendor/maplibre-gl.js': 'ML', 'data/ut/raw_dwr_properties.json': 'DWR-saved' };
    const SAVED = Object.fromEntries(Object.entries(MAPS).map(([u, b]) => [swUrl(u), b]).sort());   // the saved maps as swDump shows them
    /* A phone on the old version: its worker installed and took over, and a map was saved. */
    async function oldPhone() {
      const caches = swCaches({ 'ranger-hawk-maps': MAPS });
      const r = await swUpdate(OLD_SRC, caches, swNetwork('old'));
      if (!r.installed) throw new Error('the old version did not install: ' + r.err);
      return { caches, before: swDump(caches) };
    }
    const shell = swLoad(SW_SRC, swCaches({}), swNetwork('x')).shell;

    for (const [name, network] of [
      ['app.js comes back 404', swNetwork('new', { status: { './app.js': 404 } })],
      ['a font drops mid-download', swNetwork('new', { drop: ['./fonts/IBMPlexMono-600.woff2'] })],
      ['a data file comes back 500', swNetwork('new', { status: { './data/ut/seasons.json': 500 } })]
    ]) {
      const { caches, before } = await oldPhone();
      const r = await swUpdate(SW_SRC, caches, network);
      const after = swDump(caches);
      ok('failed download (' + name + '): the install fails', r.installed === false);
      ok('failed download (' + name + '): the new worker did not take over', r.w.calls.skipWaiting === 0 && r.w.calls.claim === 0);
      ok('failed download (' + name + '): the old cache is byte for byte what it was', JSON.stringify(after[OLD]) === JSON.stringify(before[OLD]) && Object.keys(before[OLD]).length === shell.length, Object.keys(after).join());
      ok('failed download (' + name + '): the saved maps are byte for byte what they were', JSON.stringify(after['ranger-hawk-maps']) === JSON.stringify(SAVED));
      ok('failed download (' + name + '): nothing from the failed download is kept', !after[NEW] || Object.keys(after[NEW]).length === 0, JSON.stringify(after[NEW]));
      /* The old worker is still in charge: with no signal it serves every shell file from its own cache. */
      const old = swLoad(OLD_SRC, caches, swNetwork('none', { offline: true }));
      const served = [];
      for (const u of shell) served.push([u, await swGet(old, u)]);
      ok('failed download (' + name + '): with no signal the old worker serves every shell file from the old cache', served.every(([u, b]) => b === 'old:' + swUrl(u)), served.filter(([u, b]) => b !== 'old:' + swUrl(u)).map(([u, b]) => u + '=' + b).join());
      /* The browser tries the update again on a later visit; with the files back it goes through. */
      const retry = await swUpdate(SW_SRC, caches, swNetwork('new'));
      const done = swDump(caches);
      ok('failed download (' + name + '): the next try with every file installs and takes over', retry.installed && retry.w.calls.skipWaiting === 1 && retry.w.calls.claim === 1);
      ok('failed download (' + name + '): after that try only the new cache and the maps are left, the maps unchanged', JSON.stringify(Object.keys(done).sort()) === JSON.stringify(['ranger-hawk-maps', NEW].sort()) && JSON.stringify(done['ranger-hawk-maps']) === JSON.stringify(SAVED), Object.keys(done).join());
    }

    {
      const { caches, before } = await oldPhone();
      const r = await swUpdate(SW_SRC, caches, swNetwork('new'));
      const after = swDump(caches);
      ok('good update: the install finishes and the new worker takes over', r.installed && r.w.calls.skipWaiting === 1 && r.w.calls.claim === 1, String(r.err));
      ok('good update: the old cache is deleted and only the new cache and the maps are left', JSON.stringify(Object.keys(after).sort()) === JSON.stringify(['ranger-hawk-maps', NEW].sort()), Object.keys(after).join());
      ok('good update: the new cache holds every shell file, fresh', Object.keys(after[NEW]).length === shell.length && shell.every(u => after[NEW][swUrl(u)] === 'new:' + swUrl(u)));
      ok('good update: the saved maps are byte for byte what they were', JSON.stringify(after['ranger-hawk-maps']) === JSON.stringify(SAVED));
      const off = swLoad(SW_SRC, caches, swNetwork('none', { offline: true }));
      const served = [];
      for (const u of shell) served.push([u, await swGet(off, u)]);
      ok('good update: with no signal the new worker serves every shell file from the new cache', served.every(([u, b]) => b === 'new:' + swUrl(u)), served.filter(([u, b]) => b !== 'new:' + swUrl(u)).map(([u, b]) => u + '=' + b).join());
    }
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run();
