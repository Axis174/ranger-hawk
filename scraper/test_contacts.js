#!/usr/bin/env node
/* Browser-free checks using synthetic contacts only. Run with:
     node scraper/test_contacts.js */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'docs', 'contacts.js'), 'utf8');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const entry = (extra = {}) => Object.assign({
  ids: ['wia:example', 'dwr:230'], name: 'T Example Ranch', county: 'Example',
  program: 'Walk-In Access', asks: 'Contact the landowner first.', contact: '',
  phones: [], needs_contact: true
}, extra);
function context(fetcher = () => Promise.reject(new Error('no network in tests'))) {
  const calls = [], listeners = [], sheets = [], stats = { renders: 0 };
  const box = {
    console, JSON, Object, Array, String, Number, RegExp, Promise, STATE: 'ut',
    document: { addEventListener(type, listener) { listeners.push({ type, listener }); } },
    fetch(url, options) { calls.push([url, options]); return fetcher(); },
    esc, openSheet(html) { sheets.push(html); }, render() { stats.renders++; }, tab: 'contacts'
  };
  vm.createContext(box);
  vm.runInContext(source + '\n;this.T = { acLoad, acFor, acList, acWords, acBlock, acSheet, state: () => ({ data: AC, state: acState }) };', box);
  return { T: box.T, calls, listeners, sheets, stats };
}
let pass = 0, fail = 0;
function ok(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail++; console.log('  FAIL ' + name);
}
const MUST = 'You must reach the owner before you set foot on this property.';
const settle = () => new Promise(resolve => setImmediate(resolve));

async function run() {
  const { T } = context();
  // This app is a public repository served as a public site. It must never render a
  // landowner's personal number, and must never offer to dial one. The builder redacts
  // them; these tests are the second lock, on the app side.
  const sentence = T.acWords('Call Pat at (435) 555-0142 (text ok)');
  ok('no telephone link is ever made', sentence.includes('tel:'), false);
  ok('words are passed through escaped, not linked', sentence, 'Call Pat at (435) 555-0142 (text ok)');
  const escaped = T.acWords('<script>alert(1)</script> 435-555-0142');
  ok('markup is escaped', [escaped.includes('<script'), escaped.includes('&lt;script&gt;')], [false, true]);
  ok('null words are empty', T.acWords(null), '');

  // Even if a number reached the data despite the builder, the app must not dial it.
  const leaked = T.acBlock(entry({ phones: ['4355550142', '4355550143'], asks: 'Call (435) 555-0142.' }));
  ok('a leaked number makes no call button', /<a class="btn" href="tel:/.test(leaked), false);
  ok('a leaked number makes no telephone link at all', leaked.includes('tel:'), false);

  const needed = T.acBlock(entry());
  ok('a property that needs a call says so', needed.includes(MUST), true);
  ok('and points at UDWR rather than carrying the number', needed.includes('wildlife.utah.gov/walkinaccess'), true);
  ok('no warning when no contact is required', T.acBlock(entry({ needs_contact: false })).includes(MUST), false);

  // UDWR's wording is quoted as UDWR's. The app's own routing line is not.
  const wording = T.acBlock(entry({ contact: 'App routing line', asks: 'Call "first".' }));
  ok('UDWR is quoted only for its own rule text', wording.includes('<b>UDWR says:</b> Call &quot;first&quot;.'), true);
  ok("the app's own line is not attributed to UDWR", wording.indexOf('App routing line'), -1);
  ok('no rule text means no UDWR quote', T.acBlock(entry({ contact: '', asks: '' })).includes('UDWR says:'), false);

  const sheet = T.acSheet(entry({ name: '<Test>', county: 'A & B', program: 'Test "program"', lat: 40.1, lon: -111.2 }));
  ok('sheet data is escaped', sheet.startsWith('<h3>&lt;Test&gt;</h3><p class="where">A &amp; B County &middot; Test &quot;program&quot;</p>'), true);
  ok('directions use coordinates', sheet.includes('href="https://maps.apple.com/?daddr=40.1,-111.2&dirflg=d"'), true);
  ok('directions precede UDWR words', sheet.indexOf('>Directions</a>') < sheet.indexOf('UDWR says:'), true);
  ok('no position means no directions', T.acSheet(entry()).includes('maps.apple.com'), false);
  ok('partial position means no directions', T.acSheet(entry({ lat: 40.1 })).includes('maps.apple.com'), false);
  ok('coordinates cannot insert markup', T.acSheet(entry({ lat: '40.1" onclick="x', lon: -111.2 })).includes('maps.apple.com'), false);

  const first = entry(), second = entry({ ids: ['dwr:231'], needs_contact: false });
  const third = entry({ ids: ['dwr:232'], needs_contact: true }), fourth = entry({ ids: ['dwr:233'], needs_contact: 'true' });
  const data = { properties: [first, second, third, fourth] };
  let finish;
  const loaded = context(() => new Promise(resolve => { finish = resolve; }));
  ok('before loading the list is empty', loaded.T.acList(), []);
  ok('lookup starts loading and returns null for now', loaded.T.acFor('dwr:230'), null);
  ok('pending state is loading', loaded.T.state().state, 'loading');
  loaded.T.acFor('dwr:0'); loaded.T.acLoad();
  ok('loading starts exactly one fetch with no-cache', loaded.calls, [['data/ut/access_contacts.json', { cache: 'no-cache' }]]);
  finish({ ok: true, json: async () => data });
  await settle();
  ok('successful load is ready and keeps JSON', [loaded.T.state().state, loaded.T.state().data], ['ready', data]);
  ok('both IDs find the same entry', [loaded.T.acFor('dwr:230') === first, loaded.T.acFor('wia:example') === first], [true, true]);
  ok('an unknown ID is null', loaded.T.acFor('dwr:0'), null);
  ok('an inherited object name is not an ID', loaded.T.acFor('toString'), null);
  ok('list keeps only true flags in file order', loaded.T.acList(), [first, third]);
  ok('successful load renders once', loaded.stats.renders, 1);
  await loaded.T.acLoad();
  ok('ready data does not load again', loaded.calls.length, 1);

  ok('one document click listener is registered', loaded.listeners.map(x => x.type), ['click']);
  const click = id => loaded.listeners[0].listener({ target: { closest(selector) { ok('click finds data-ac ancestor', selector, '[data-ac]'); return { dataset: { ac: id } }; } } });
  click('dwr:230');
  ok('nested click opens the matching sheet', loaded.sheets, [loaded.T.acSheet(first)]);
  click('dwr:0');
  loaded.listeners[0].listener({ target: { closest: () => null } });
  ok('unknown or unrelated clicks open nothing', loaded.sheets.length, 1);

  const failed = context();
  ok('nothing loaded and failed fetch starts with an empty list', failed.T.acList(), []);
  await failed.T.acLoad();
  ok('rejected fetch does not throw and has no entries', [failed.T.state(), failed.T.acList(), failed.T.acFor('dwr:230')], [{ data: { properties: [] }, state: 'failed' }, [], null]);
  await failed.T.acLoad();
  ok('failed load also runs only once', failed.calls.length, 1);
  ok('failed load does not render success', failed.stats.renders, 0);
  for (const fetcher of [
    () => { throw new Error('synthetic failure'); },
    async () => ({ ok: false, json: async () => data }),
    async () => ({ ok: true, json: async () => { throw new Error('synthetic parse failure'); } }),
    async () => ({ ok: true, json: async () => ({}) })
  ]) {
    const bad = context(fetcher);
    await bad.T.acLoad();
    ok('failed response stays contained', [bad.T.state().state, bad.T.acList()], ['failed', []]);
  }
}
run().catch(() => { fail++; console.log('  FAIL unexpected test exception'); }).then(() => {
  console.log(`${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
});
