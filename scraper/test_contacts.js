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
    console, JSON, Object, Array, String, Number, RegExp, Promise,
    document: { addEventListener(type, listener) { listeners.push({ type, listener }); } },
    fetch(url, options) { calls.push([url, options]); return fetcher(); },
    esc, openSheet(html) { sheets.push(html); }, render() { stats.renders++; }, tab: 'contacts'
  };
  vm.createContext(box);
  vm.runInContext(source + '\n;this.T = { acLoad, acFor, acList, acPretty, acWords, acBlock, acSheet, state: () => ({ data: AC, state: acState }) };', box);
  return { T: box.T, calls, listeners, sheets, stats };
}
let pass = 0, fail = 0;
function ok(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail++; console.log('  FAIL ' + name);
}
const MISSING = 'UDWR asks you to contact the owner and publishes no number for this property. Ask the DWR office for the region.';
const NOTE = 'The number is the one UDWR publishes for this property. The app takes nothing from any other source. Not legal advice.';
const settle = () => new Promise(resolve => setImmediate(resolve));

async function run() {
  const { T } = context();
  ok('pretty phone', T.acPretty('4355550142'), '(435) 555-0142');
  const sentence = T.acWords('Call Pat at (435) 555-0142 (text ok)');
  ok('phone is a telephone link', sentence.includes('href="tel:4355550142"'), true);
  ok('published spelling and surrounding words stay', sentence, 'Call Pat at <a href="tel:4355550142">(435) 555-0142</a> (text ok)');
  const escaped = T.acWords('<script>alert(1)</script> 435-555-0142');
  ok('markup is escaped before linking', [escaped.includes('<script'), escaped.includes('&lt;script&gt;'), escaped.includes('href="tel:4355550142"')], [false, true, true]);
  ['(435) 555-0142', '435-555-0142', '435.555.0142', '1-(435)-555-0142', '(435)555-0142'].forEach(phone => {
    ok('phone spelling links without changing its words: ' + phone, T.acWords(phone), '<a href="tel:4355550142">' + phone + '</a>');
  });
  ok('two phones stay in their original order', T.acWords('(435) 555-0142 then (435) 555-0143'), '<a href="tel:4355550142">(435) 555-0142</a> then <a href="tel:4355550143">(435) 555-0143</a>');
  ok('date postal code and local number are not telephone links', /tel:/.test(T.acWords('2026-09-28 84010-1234 555-0142')), false);
  ok('null words are empty', T.acWords(null), '');

  const noPhone = T.acBlock(entry());
  ok('required contact without a number says so exactly', noPhone.includes('<p class="fine" style="padding:10px 16px 0">' + MISSING + '</p>'), true);
  ok('missing number has no telephone link', noPhone.includes('tel:'), false);
  ok('source note is always last', noPhone.endsWith('<p class="fine" style="padding:10px 16px 0">' + NOTE + '</p>'), true);
  ok('no missing-number warning when contact is not required', T.acBlock(entry({ needs_contact: false })).includes(MISSING), false);
  const two = T.acBlock(entry({ phones: ['4355550142', '4355550143'] }));
  ok('two numbers make two call buttons', (two.match(/<a class="btn" href="tel:[0-9]+">Call /g) || []).length, 2);
  ok('each call button has its own actions container', (two.match(/<div class="acts">/g) || []).length, 2);
  ok('call buttons keep number order', two.indexOf('tel:4355550142') < two.indexOf('tel:4355550143'), true);
  ok('with numbers there is no missing-number warning', two.includes(MISSING), false);
  const wording = T.acBlock(entry({ contact: 'Contact & <owner>', asks: 'Call "first".' }));
  ok('contact words precede rule words with one break', wording.startsWith('<div class="warnbox" style="margin:12px 16px 0"><b>UDWR says:</b> Contact &amp; &lt;owner&gt;<br>Call &quot;first&quot;.</div>'), true);
  ok('empty words do not add breaks', T.acBlock(entry({ contact: '', asks: '' })).includes('<br>'), false);
  const badPhone = T.acBlock(entry({ phones: ['4355550142"><script>'] }));
  ok('telephone href is digits only', [badPhone.includes('href="tel:4355550142"'), badPhone.includes('<script>')], [true, false]);

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
  ok('loading starts exactly one fetch with no-cache', loaded.calls, [['data/access_contacts.json', { cache: 'no-cache' }]]);
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
