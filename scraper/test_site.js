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
    '\n;this.T = { paidLink, vPrivacy, vMoney, siteCount, plLoad, plShown,' +
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
    const want = '<p class="fine paidlink"><b>Paid link</b> &middot; <a href="https://example.com/join?a=1&amp;b=2" target="_blank" rel="sponsored noopener">Draw odds and unit research at Example Co</a>. Ranger Hawk earns a commission if you join or buy through it.</p>';
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

    const noScript = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
    ok('no third-party script tag in index.html', (noScript.match(/<script[^>]*src="([^"]+)"/g) || []).every(t => !/src="(https?:)?\/\//.test(t)));
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
    ok('Privacy links the GitHub issues page', a.indexOf('href="https://github.com/Axis174/ranger-hawk/issues" target="_blank" rel="noopener">the project\'s GitHub page</a>') > 0);
    ok('Privacy has no emoji', !EMOJI.test(a) && !EMOJI.test(b));
    ok('Privacy has no script or inline handler', !/<script|onclick=|onerror=/i.test(a));
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
    T.setLinks([Object.assign({}, ENTRY, { company: 'Bad first', url: 'javascript:alert(1)' }), Object.assign({}, ENTRY, { company: 'First <Co>' }), Object.assign({}, ENTRY, { company: 'Second Co', slot: 'draw' }), Object.assign({}, ENTRY, { company: 'Elsewhere', slot: 'nowhere' }), Object.assign({}, ENTRY, { company: 'Bad', url: 'http://x.com' })]);
    const m2 = T.vMoney();
    ok('Money lists only the company whose link is drawn, escaped', m2.indexOf('Paid links in the app today: First &lt;Co&gt;</p>') >= 0, m2.slice(m2.indexOf('Paid links in the app today')));
    ok('and does not list an unplaced slot or a non-https link', m2.indexOf('Elsewhere') < 0 && m2.indexOf('Bad') < 0);
    ok('Money with links has no "none"', m2.indexOf('today: none') < 0);
  }

  /* ---- the wiring in the other files */
  {
    const app = fs.readFileSync(path.join(ROOT, 'docs', 'app.js'), 'utf8'), go = fs.readFileSync(path.join(ROOT, 'docs', 'go.js'), 'utf8');
    const idx = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8'), sw = fs.readFileSync(path.join(ROOT, 'docs', 'sw.js'), 'utf8');
    ok('app.js titles: Privacy and How Ranger Hawk makes money', app.indexOf("privacy: 'Privacy', money: 'How Ranger Hawk makes money'") > 0);
    ok('app.js draws the two screens', /privacy: \(typeof vPrivacy/.test(app) && /money: \(typeof vMoney/.test(app));
    ok('app.js counts the screen from render()', /function render\(\) \{\n  if \(typeof siteCount === 'function'\) siteCount\(tab\)/.test(app));
    ok('vDraw puts the paid link after the agency paragraph', /Always confirm at utahdraws\.com before applying\.<\/p>`;\n  if \(typeof paidLink === 'function'\) h \+= paidLink\('draw'\);\n  return h;/.test(app));
    ok('go.js has the two rows', /tab: 'privacy'/.test(go) && /tab: 'money'/.test(go));
    ok('index.html loads site.js after go.js', idx.indexOf('<script src="go.js"></script>\n<script src="site.js"></script>') > 0);
    ok('sw.js is v36 and lists site.js and paid_links.json', /VERSION = 'ranger-hawk-v36'/.test(sw) && sw.indexOf("'./site.js'") > 0 && sw.indexOf("'./data/ut/paid_links.json'") > 0);
    const scripts = (idx.match(/<script\b[^>]*>/g) || []).filter(t => !/type="application\/ld\+json"/.test(t));   // the structured data in <head> is not an app script
    ok('index.html loads state.js first before app.js and sw.js lists it', scripts[0] === '<script src="state.js">' && scripts.indexOf('<script src="app.js">') > 0 && sw.indexOf("'./state.js'") > 0);
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run();
