#!/usr/bin/env node
/* One-time app-mode comparison against saved main sources; no nightly fixture.
   node scraper/compare_unit_sheets.js /path/to/saved-main-sources */
'use strict';
const fs = require('fs'), path = require('path');
const { phone } = require('./unit_vm.js');
const docs = path.resolve(__dirname, '..', 'docs');
const baseline = process.argv[2];
if (!baseline) { console.error('Usage: node scraper/compare_unit_sheets.js <saved-main-source-directory>'); process.exit(2); }
const read = file => JSON.parse(fs.readFileSync(path.join(docs, 'data/ut', file), 'utf8'));
const config = read('config.json'), HU = read('hunt_units_' + config.hunt_year + '.json');
const data = { config, HU, HT: read('hunt_table_' + config.hunt_year + '.json'), UNITS: read('units_geo.json').units,
  ODDS: read('draw_odds.json'), seasons: read('seasons.json') };
const sources = Object.fromEntries(['app.js', 'finder.js', 'units.js'].map(file => [file, fs.readFileSync(path.join(baseline, file), 'utf8')]));
const eligible = data.UNITS.filter(u => HU.slugs[u.n] && Object.values(HU.hunts).flat().some(r => r.boundary_id === u.id));
const clocks = ['2026-10-15T18:00:00Z', '2027-02-15T19:00:00Z'];
let compared = 0, differences = 0;
for (const clock of clocks) {
  const opts = { docs, now: clock, serveFetches: false, scripts: ['state.js', 'app.js', 'finder.js', 'units.js'] };
  const main = phone('', { ...opts, sources }), branch = phone('', opts);
  for (const p of [main, branch]) { p.T.setData(data); p.T.mode(false, Date.parse(clock)); }
  for (const u of eligible) {
    const before = main.T.sheetUnit(u.id), after = branch.T.sheetUnit(u.id);
    compared++;
    if (!before || before !== after) { differences++; console.error('DIFF ' + clock + ' ' + u.n); }
  }
}
console.log(`${eligible.length} polygons; ${clocks.length} clocks; ${compared} sheets compared; ${differences} diffs`);
process.exit(differences ? 1 : 0);
