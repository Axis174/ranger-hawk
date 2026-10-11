#!/usr/bin/env node
/* The app-mode sheet fixture is a record of main before the static renderer was
   added. It is regenerated only by hand, from an explicitly supplied old file:

       node scraper/fishing/app_sheet_fixture.js --write /tmp/main-fishing.js <commit>

   Tests never write it. The stopped clock and ordinary-day notices below avoid
   daily notice pulls changing this record. Rules, places and anchor towns remain
   the real files; a deliberate change to those needs a reviewed fixture update. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..'), D = p => path.join(ROOT, 'docs', p);
const FIXED = Date.UTC(2026, 8, 27, 18, 0, 0);
const ZONES = ['America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/New_York', 'UTC', 'Pacific/Auckland'];
const FILE = path.join(__dirname, 'app_sheet_hashes.json');
const read = name => JSON.parse(fs.readFileSync(D('data/ut/' + name), 'utf8'));
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function context(source, extra) {
  const R = read('fishing_rules.json'), P = read('fishing_places.json');
  /* This is the notice list the built amendments describe, with every checksum
     agreeing and freshness stopped at the suite's clock. Unread/reworded notices
     are tested separately in test_fishing.js against the daily data. */
  const N = {
    ok: true, last_ok: new Date(FIXED).toISOString(), sha: R._notices_sha,
    guidebook: { sha: R._edition.sha }, other: (R._notices_other || []).map(s => ['p', s]),
    notices: R.amendments.map(a => ({ slug: a.notice, url: a.url, title: a.name, name: a.name,
      county: a.county, sha: a.sha, pdf_sha: a.pdf_sha, text: [] }))
  };
  class TestDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(FIXED); }
    static now() { return FIXED; }
  }
  const STORE = new Map(Object.entries({
    'ha.anchors': JSON.stringify([{ id: 'slc' }, { id: 'heber' }, { id: 'torrey' }]), 'ha.anchor': 'heber'
  }));
  const box = {
    console, Date: TestDate, Math, JSON, Object, Array, String, Number, RegExp, Promise, Set, Map, Intl, URLSearchParams,
    document: { addEventListener() {} }, window: { addEventListener() {}, scrollTo() {} }, navigator: {},
    localStorage: { getItem: k => STORE.has(k) ? STORE.get(k) : null, setItem: (k, v) => STORE.set(k, String(v)) },
    fetch: () => Promise.reject(new Error('no network in sheet fixture')), STATE: 'ut',
    $: () => null, render() {}, openSheet() {}, loadWx() {}, tab: 'today', esc,
    DB: { config: read('config.json') }, fmt: d => String(d),
    miles(aLat, aLon, bLat, bLon) {
      const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
      return 3958.8 * 2 * Math.asin(Math.sqrt(h));
    }
  };
  Object.assign(box, extra || {});
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(D('state.js'), 'utf8'), box);
  vm.runInContext(source + '\n;this.T = { fish, sheetFishWater, fishLoad, ' +
    'set(r,p,n) { FR=r; FP=p; FNT=n; fishIndex(); }, ' +
    'fWaterParam: typeof fWaterParam === "function" ? fWaterParam : null, ' +
    'fishOpenWaterLink: typeof fishOpenWaterLink === "function" ? fishOpenWaterLink : null };', box);
  box.T.fish.static = false;
  return { box, R, P, N, T: box.T };
}
function sheets(source) {
  const c = context(source); c.T.set(c.R, c.P, c.N);
  const ids = c.R.waters.map(w => w.id).concat(c.R.community.members.map(m => 'community:' + m.id));
  return Object.fromEntries(ids.map(id => [id, c.T.sheetFishWater(id)]));
}
const hashes = html => Object.fromEntries(Object.entries(html).map(([id, s]) => [id, sha(s)]));
module.exports = { context, sheets, hashes, FILE, FIXED, ZONES };

if (require.main === module) {
  const [mode, file, commit] = process.argv.slice(2);
  if (mode === '--render' && file) process.stdout.write(JSON.stringify(hashes(sheets(fs.readFileSync(file, 'utf8')))));
  else if (mode === '--write' && file && commit) {
    const { spawnSync } = require('child_process'), zones = {};
    for (const z of ZONES) {
      const r = spawnSync(process.execPath, [__filename, '--render', path.resolve(file)], {
        env: Object.assign({}, process.env, { TZ: z, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }), encoding: 'utf8'
      });
      if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'sheet fixture child failed');
      zones[z] = JSON.parse(r.stdout);
    }
    const baseline = { commit, fishing_sha256: sha(fs.readFileSync(file)), clock: new Date(FIXED).toISOString(),
      notice_list: 'built amendments, matching hashes, fresh at the stopped clock', locale: 'en-US' };
    const inputs = Object.fromEntries(['fishing_rules.json', 'fishing_places.json', 'config.json'].map(n => [n, sha(fs.readFileSync(D('data/ut/' + n)))]));
    fs.writeFileSync(FILE, JSON.stringify({ baseline, inputs, zones }, null, 2) + '\n');
    console.log(`Wrote ${Object.keys(zones).length * Object.keys(zones[ZONES[0]]).length} sheet hashes from ${commit}`);
  } else throw new Error('Use --write <saved main fishing.js> <baseline commit>, or --render <source>');
}
