#!/usr/bin/env node
/* Builds the static pages that sit beside the app, and the search plumbing for them.

       node scraper/build_pages.js

   Reads  scraper/pages/content.js   every sentence the pages say (one source)
          docs/data/ut/*.json        the counts and the data refresh date
          docs/state.js + site.js    the Privacy and Money screens, loaded the way the browser loads them
          docs/app.js + finder.js + units.js (after state.js), the app's unit sheets
   Writes docs/hunting/index.html, docs/fishing/index.html, docs/privacy/index.html,
          docs/how-ranger-hawk-makes-money/index.html, docs/404.html, docs/sitemap.xml,
          docs/llms.txt (and docs/about/index.html if content.js ever exports ABOUT)
   Edits  two marked regions of docs/index.html (seo, shell) and three keys of
          docs/manifest.webmanifest (description, lang, categories).

   Same inputs and Utah build date, same bytes. Water and unit pages use noon America/Denver;
   --date=YYYY-MM-DD fixes that date for a repeatable build. A count that is not a whole
   number above zero stops the build (see checkCounts), and so does a {placeholder} left
   in any output. Run before the tests; refresh.yml does. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const C = require('./pages/content.js');
const { phone } = require('./unit_vm.js');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const DATA = path.join(DOCS, 'data', 'ut');
const SITE = C.SITE;

const OG_IMAGE = SITE + '/icons/og-image.png';
const OG_ALT = 'Ranger Hawk: the hawk head mark and the words Utah hunting and fishing: seasons, rules, access, maps';
const FEED = { label: 'Calendar feed (hunt.ics)', url: SITE + '/hunt.ics', note: 'every Utah hunting deadline as a calendar feed' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

class BuildError extends Error {}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/* JSON for a <script type="application/ld+json"> block: no raw < > & so no text can close the tag. */
const ldBlock = obj => '<script type="application/ld+json">\n' +
  JSON.stringify(obj, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026') + '\n</script>';
const readJson = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

/* How a page says its counties: the sheet header's own words (docs/fishing.js, sheetFishWater).
   One county reads "Summit County"; several read "Summit, Utah, Wasatch counties". */
const countyText = counties => counties.join(', ') + (counties.length > 1 ? ' counties' : ' County');

/* Water rules use Utah wall-clock fields, regardless of the build machine's zone.
   This Date subclass keeps real timestamps but supplies Denver's local fields to
   the app renderer. It avoids changing process.env.TZ, which would also change any
   test or other builder sharing this process. */
const DENVER = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
function denverFields(date) {
  const p = {};
  DENVER.formatToParts(date).forEach(x => { if (x.type !== 'literal') p[x.type] = Number(x.value); });
  return p;
}
function denverTime(...args) {
  const wall = Date.UTC(...args);
  let at = wall;
  for (let i = 0; i < 3; i++) {
    const p = denverFields(new Date(at));
    const delta = wall - Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second, new Date(at).getUTCMilliseconds());
    at += delta;
    if (!delta) break;
  }
  return at;
}
function utahDate(value = new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number), check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d) return value;
    throw new BuildError('invalid Utah build date: ' + value);
  }
  const instant = new Date(value);
  if (isNaN(instant)) throw new BuildError('invalid Utah build date: ' + value);
  const p = denverFields(instant);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
function denverNoon(date) {
  const [y, m, d] = utahDate(date).split('-').map(Number);
  return denverTime(y, m - 1, d, 12, 0, 0);
}

/* The static sheets are the real fishing.js renderer. The only functions exposed
   below are needed to render, to use its exact amendment state, and to join the
   county list the same way as the app. No rule wording is copied here. */
function loadFishing(date = new Date()) {
  const iso = utahDate(date), noon = denverNoon(iso);
  class UtahDate extends Date {
    constructor(...args) { super(args.length > 1 ? denverTime(...args) : args.length ? args[0] : noon); }
    static now() { return noon; }
    getFullYear() { return denverFields(this).year; }
    getMonth() { return denverFields(this).month - 1; }
    getDate() { return denverFields(this).day; }
    getHours() { return denverFields(this).hour % 24; }
    getMinutes() { return denverFields(this).minute; }
    getSeconds() { return denverFields(this).second; }
    getDay() { const p = denverFields(this); return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); }
    toLocaleDateString(locale, options) { return super.toLocaleDateString(locale, Object.assign({}, options, { timeZone: 'America/Denver' })); }
  }
  const noop = () => {};
  const box = {
    console, Date: UtahDate, Intl, URLSearchParams,
    document: { addEventListener: noop },
    esc: s => esc(s == null ? '' : s),
    fmt: d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    home: 'heber', tab: 'fish', render: noop,
  };
  vm.createContext(box);
  try {
    vm.runInContext(fs.readFileSync(path.join(DOCS, 'fishing.js'), 'utf8') + '\n;this.F = { set(r, p, n) { FR = r; FP = p; FNT = n; fish.static = true; fish.now = ' + noon + '; fishIndex(); }, sheetFishWater, fAmendState, fCounties, fNow };', box, { filename: 'docs/fishing.js' });
    const rules = readJson('fishing_rules.json'), places = readJson('fishing_places.json'), notices = readJson('fishing_notices.json');
    box.F.set(rules, places, notices);
    return {
      rules, places, notices, date: iso, now: box.F.fNow(),
      render: id => box.F.sheetFishWater(id),
      amendState: a => box.F.fAmendState(a, box.F.fNow()),
      counties: entry => Array.from(box.F.fCounties(entry)),
    };
  } catch (e) {
    throw new BuildError('loading the real docs/fishing.js static renderer failed: ' + e.message);
  }
}

/* A separate VM runs the same app scripts and browser stubs as test_units.
   Startup fetches never settle: only the committed objects assigned here can
   reach the renderer. This keeps build() synchronous and entirely offline. */
function loadUnits(date = new Date()) {
  const iso = utahDate(date), noon = denverNoon(iso);
  try {
    const config = readJson('config.json'), seasons = readJson('seasons.json');
    const HU = readJson(`hunt_units_${config.hunt_year}.json`), HT = readJson(`hunt_table_${config.hunt_year}.json`);
    const UNITS = readJson('units_geo.json').units, ODDS = readJson('draw_odds.json');
    const p = phone('', { docs: DOCS, now: noon, storage: {}, serveFetches: false,
      scripts: ['state.js', 'app.js', 'finder.js', 'units.js'] });
    p.T.setData({ HU, HT, UNITS, ODDS, config, seasons });
    p.T.mode(true, noon);
    p.T.link(slug => '/hunting/units/' + slug + '/');
    return { HU, HT, UNITS, ODDS, config, seasons, date: iso, now: noon,
      species: Array.from(p.T.species), render: id => p.T.sheetUnit(id),
      edition: () => p.T.hEdition(), generalRows: row => p.T.fGeneralRows(row.species, row, null),
      tableHunts: row => p.T.fTableHunts(row) };
  } catch (e) {
    throw new BuildError('loading the real unit renderer failed: ' + e.message);
  }
}

function unitPages(hunting) {
  const rows = Object.values(hunting.HU.hunts).flat(), slugs = new Set();
  const index = hunting.UNITS.map(u => {
    const entries = rows.filter(r => r.boundary_id === u.id);
    const slug = Object.prototype.hasOwnProperty.call(hunting.HU.slugs, u.n) && hunting.HU.slugs[u.n];
    if (!!entries.length !== !!slug) throw new BuildError('hunt rows and slug disagree for ' + u.n);
    if (slug && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slugs.has(slug)))
      throw new BuildError('invalid or duplicate unit slug for ' + u.n);
    if (slug) slugs.add(slug);
    return { id: u.id, name: u.n, slug: slug || null, rows: entries,
      species: hunting.species.filter(s => entries.some(r => r.species === s)),
      path: slug ? '/hunting/units/' + slug + '/' : null };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en-US'));
  if (rows.some(r => !hunting.UNITS.some(u => u.id === r.boundary_id)))
    throw new BuildError('a hunt-list row has no unit polygon');
  return { pages: index.filter(p => p.path), index };
}

/* Pages use the rule id, never a place id. The Burraston twin's community entry
   goes to its water page, and pointers go to their target without getting a page. */
function fishingPages(fishing) {
  const r = fishing.rules, waters = new Map(r.waters.map(w => [w.id, w]));
  const kept = id => (r.amendments || []).filter(a => (a.community ? 'community:' + a.community : a.water) === id)
    .filter(a => ['on', 'later'].includes(fishing.amendState(a).k)).sort((a, b) => a.from.localeCompare(b.from));
  const waterPath = id => '/fishing/waters/' + id + '/';
  const communityPath = id => waters.has(id) && waters.get(id).kind === 'water' ? waterPath(id) : '/fishing/community/' + id + '/';
  const pages = [], index = [];
  for (const w of r.waters) {
    const changes = kept(w.id), pagePath = waterPath(w.id);
    if (w.kind === 'water' || (w.kind === 'notice' && changes.length)) pages.push({ kind: w.kind, id: w.id, name: w.name, counties: fishing.counties(w), path: pagePath, page: w.page, changes, entry: w });
    let target = w, targetReach = '';
    if (w.kind === 'pointer') {
      target = waters.get(w.see.water);
      if (!target || target.kind === 'pointer') throw new BuildError('a fishing pointer has no page target: ' + w.id);
      const keys = (w.see || {}).reaches || [];
      const named = (target.reaches || []).filter(reach => keys.includes(reach.key) && reach.where).map(reach => reach.where);
      targetReach = named.join('; ');
    }
    index.push({ kind: w.kind, id: w.id, name: w.name, counties: fishing.counties(w), path: target.kind === 'notice' && !kept(target.id).length ? null : waterPath(target.id), target: target.id, targetName: target.name, targetReach });
  }
  for (const m of r.community.members) {
    const id = 'community:' + m.id, pagePath = communityPath(m.id);
    /* A community member that is also a guidebook water (Burraston Ponds) has one page, the
       water's, and one index line, the water entry's. Only the rest are listed here. */
    if (!pagePath.startsWith('/fishing/community/')) continue;
    pages.push({ kind: 'community', id, name: m.name, counties: [m.county], path: pagePath, page: r.community.page, changes: kept(id), entry: m });
    index.push({ kind: 'community', id, name: m.name, counties: [m.county], path: pagePath, target: id, targetName: m.name, targetReach: '' });
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'en-US') || a.counties.join(', ').localeCompare(b.counties.join(', '), 'en-US') || a.id.localeCompare(b.id, 'en-US');
  pages.sort(byName); index.sort(byName);
  return { pages, index, counts: { water: pages.filter(p => p.kind === 'water').length, notice: pages.filter(p => p.kind === 'notice').length, community: pages.filter(p => p.kind === 'community').length } };
}

/* ------------------------------------------------------------------ counts --- */
/* Each count is taken the way the app itself counts it, so a page can never say a
   number the app does not show:
     access_points    DB.birds.length         app.js vAccess "N places" (bird_access.json)
     fish_places      FP.places.length        fishing.js (fishing_places.json)
     specific_waters  FR.waters.length        fishing.js "Waters with their own rules ... of N"
     community_waters FR.community.members    fishing.js "Community fishing waters ... of N"
     general_rules    FR.statewide.rules      fishing.js, the Statewide list (fishing_rules.json) */
function computeCounts() {
  const birds = readJson('bird_access.json'), places = readJson('fishing_places.json'), rules = readJson('fishing_rules.json');
  return {
    access_points: birds.length,
    fish_places: places.places.length,
    specific_waters: rules.waters.length,
    community_waters: rules.community.members.length,
    general_rules: rules.statewide.rules.length,
  };
}

/* The counts come from the same files the app draws, so they are right by construction and
   are not compared with any prose. The only check: each is a whole number above zero, so an
   empty or missing data file stops the build instead of printing "0 places" on a page. */
function checkCounts(counts) {
  const bad = Object.keys(counts).filter(k => !Number.isInteger(counts[k]) || counts[k] <= 0).map(k => `${k} is ${counts[k]}`);
  if (bad.length) throw new BuildError('a count is not a whole number above zero, so a data file is empty or has changed shape. Nothing was written.\n  ' + bad.join('\n  '));
}

/* ------------------------------------------------------------ refresh date --- */
/* The newest "run" in docs/data/ut/changelog.json (scraper/refresh.py appends one per daily
   refresh, in UTC): the footer's "Sources last checked". The app shows no "updated" date of its own. */
function refreshDate() {
  const runs = (readJson('changelog.json').runs || []).map(r => String((r && r.run) || '').slice(0, 10)).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort();
  if (!runs.length) throw new BuildError('docs/data/ut/changelog.json has no run date to put in the footer');
  return runs[runs.length - 1];
}
const humanDate = iso => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

/* -------------------------------------------- the Privacy and Money screens --- */
/* Loads docs/state.js and then docs/site.js into ONE vm context, as the browser does, with
   a tolerant set of stubs, and returns what vPrivacy() and vMoney() draw. The real
   paid_links.json is put where the app would have fetched it, so the money page says what the
   app says. */
function loadSite() {
  const noop = () => {};
  const appEsc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));   // app.js:5
  class FakeImage { set src(v) { /* the visitor-count pixel: nothing is sent */ } }
  const box = {
    console,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop, key: () => null, length: 0 },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop, key: () => null, length: 0 },
    navigator: { onLine: true, language: 'en-US', userAgent: 'build_pages' },
    document: { referrer: '', body: { classList: { toggle: noop, add: noop, remove: noop } }, addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    location: { href: SITE + '/', origin: SITE, hash: '', search: '', pathname: '/' },
    addEventListener: noop, setTimeout: noop, clearTimeout: noop,
    fetch: () => Promise.reject(new Error('offline: build_pages loads no data')),
    Image: FakeImage, esc: appEsc, $: () => null, tab: 'privacy', render: noop,
  };
  box.window = box; box.self = box; box.globalThis = box;
  vm.createContext(box);
  for (const f of ['state.js', 'site.js']) {
    try { vm.runInContext(fs.readFileSync(path.join(DOCS, f), 'utf8'), box, { filename: 'docs/' + f }); }
    catch (e) {
      throw new BuildError(`loading docs/${f} failed: ${e.message}\n  The Privacy and Money screens are drawn by running the real scripts. If ${f} now needs another browser global at load time, add it to the stub set in loadSite() in scraper/build_pages.js.`);
    }
  }
  const have = vm.runInContext("[typeof vPrivacy, typeof vMoney]", box);
  if (have[0] !== 'function' || have[1] !== 'function') {
    throw new BuildError(`docs/site.js did not define both vPrivacy() and vMoney() after docs/state.js and docs/site.js were loaded together (got ${have.join(', ')}). The static Privacy and Money pages are built from them.`);
  }
  try {
    const paid = readJson('paid_links.json');
    vm.runInContext('PL = ' + JSON.stringify({ links: Array.isArray(paid.links) ? paid.links : [] }) + '; plState = "ready";', box);
  } catch (e) { /* the fallback is the app's own first paint: no paid links */ }
  const privacy = vm.runInContext('vPrivacy()', box), money = vm.runInContext('vMoney()', box);
  if (typeof privacy !== 'string' || typeof money !== 'string' || !privacy.length || !money.length) throw new BuildError('vPrivacy() or vMoney() returned nothing');
  return { privacy, money };
}

/* ------------------------------------------------------------------- pages --- */
function pageDefs() {
  const defs = [
    { key: 'hunting', label: 'Hunting in Utah', c: C.HUNTING, kind: 'article' },
    { key: 'fishing', label: 'Fishing in Utah', c: C.FISHING, kind: 'article' },
  ];
  if (C.ABOUT) defs.push({ key: 'about', label: C.ABOUT.label || 'About', c: Object.assign({ path: '/about/' }, C.ABOUT), kind: 'article' });
  defs.push(
    { key: 'privacy', label: 'Privacy', c: C.PRIVACY, kind: 'embed', embed: 'privacy', h1: 'Privacy' },
    { key: 'money', label: 'How Ranger Hawk makes money', c: C.MONEY, kind: 'embed', embed: 'money', h1: 'How Ranger Hawk makes money' });
  return defs;
}
const fileOf = p => p === '/' ? path.join(DOCS, 'index.html') : path.join(DOCS, p.replace(/^\/|\/$/g, ''), 'index.html');

function ogTags(t) {
  return [
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${esc(C.NAME)}">`,
    `<meta property="og:title" content="${esc(t.title)}">`,
    `<meta property="og:description" content="${esc(t.description)}">`,
    t.url ? `<meta property="og:url" content="${esc(t.url)}">` : null,
    `<meta property="og:image" content="${OG_IMAGE}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="${esc(OG_ALT)}">`,
    '<meta property="og:locale" content="en_US">',
    '<meta name="twitter:card" content="summary_large_image">',
  ].filter(Boolean);
}
const fontPreloads = rel => [
  `<link rel="preload" href="${rel}fonts/ZillaSlab-700.woff2" as="font" type="font/woff2" crossorigin>`,
  `<link rel="preload" href="${rel}fonts/PublicSans-var.woff2" as="font" type="font/woff2" crossorigin>`,
];

/* rel is where the site root is from this page: "../" for /x/index.html, "/" for the 404 (served at any path). */
function staticHead(t, rel) {
  const canonical = t.canonical || null;
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    `<title>${esc(t.title)}</title>`,
    `<meta name="description" content="${esc(t.description)}">`,
    t.noindex ? '<meta name="robots" content="noindex">' : null,
    canonical ? `<link rel="canonical" href="${canonical}">` : null,
    ...ogTags({ title: t.title, description: t.description, url: canonical }),
    '<meta name="theme-color" content="#2C2C2C">',
    `<link rel="manifest" href="${rel}manifest.webmanifest">`,
    `<link rel="icon" href="${rel}favicon.ico" sizes="48x48">`,
    `<link rel="icon" type="image/svg+xml" href="${rel}icons/favicon.svg">`,
    `<link rel="icon" type="image/png" sizes="32x32" href="${rel}icons/favicon-32.png">`,
    `<link rel="apple-touch-icon" href="${rel}icons/icon-180.png">`,
    ...fontPreloads(rel),
    `<link rel="stylesheet" href="${rel}styles.css">`,
    `<link rel="stylesheet" href="${rel}page.css">`,
    ...(t.ld || []).map(ldBlock),
  ].filter(Boolean).join('\n');
}

function build(options = {}) {
  const counts = computeCounts();
  checkCounts(counts);
  const hunting = loadUnits(options.date === undefined ? new Date() : options.date);
  const fields = Object.assign({ hunt_year: hunting.config.hunt_year }, counts);
  const fill = s => String(s).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) => {
    if (!Object.prototype.hasOwnProperty.call(fields, k)) throw new BuildError(`content.js uses ${m} and build_pages.js has no field of that name`);
    return String(fields[k]);
  });
  const iso = refreshDate(), human = humanDate(iso);
  const site = loadSite();
  const fishing = loadFishing(options.date === undefined ? new Date() : options.date);
  const waterDefs = fishingPages(fishing);
  const unitDefs = unitPages(hunting);
  const indexes = [
    { key: 'fishing', hub: C.FISHING, c: C.FISHING.waterIndex, label: 'Every water', items: waterDefs.index },
    { key: 'hunting', hub: C.HUNTING, c: C.HUNTING.unitIndex, label: 'Every hunt unit', items: unitDefs.index },
  ];
  const defs = pageDefs();
  const out = {};   // absolute path -> text

  const footer = (rel, here) => {
    const links = defs.map(d => ({ href: rel + d.c.path.replace(/^\//, ''), label: d.label, key: d.key }));
    return `<footer>
<div class="wrap">
<p>${esc(C.DISCLAIMER)}</p>
<nav aria-label="Pages"><ul>
${links.map(l => `<li><a href="${l.href}"${l.key === here ? ' aria-current="page"' : ''}>${esc(l.label)}</a></li>`).join('\n')}
</ul></nav>
<p>Sources last checked ${human}.</p>
</div>
</footer>`;
  };
  const header = rel => `<header class="bar">
<div class="bar-in"><a class="brand" href="${rel}"><img src="${rel}icons/rangerhawk-wordmark.svg" alt="Ranger Hawk" width="154" height="24"></a></div>
</header>`;
  const doc = (head, rel, main, here) => `<!doctype html>
<html lang="en">
<head>
${head}
</head>
<body>
${header(rel)}
<main>
${main}
</main>
${footer(rel, here)}
</body>
</html>
`;

  const crumb = (d, url) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
    { '@type': 'ListItem', position: 2, name: d.label, item: url }] });

  /* ---- hunting, fishing (and about, if there is one) and the two embedded screens */
  for (const d of defs) {
    const url = SITE + d.c.path, rel = '../';
    const ld = [crumb(d, url)];
    let main;
    if (d.kind === 'article') {
      const c = d.c;
      const index = c.waterIndex || c.unitIndex;
      const faq = (c.faq || []).map(f => ({ q: fill(f.q), a: fill(f.a) }));
      if (faq.length) ld.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
      main = `<div class="wrap page">
<h1>${esc(fill(c.h1))}</h1>
<p class="lead">${esc(fill(c.lead))}</p>
${index ? `<p><a href="${esc(index.path)}">${esc(index.label)}</a></p>\n` : ''}${(c.sections || []).map(s => `<section>
<h2>${esc(fill(s.h2))}</h2>
${s.p.map(p => `<p>${esc(fill(p))}</p>`).join('\n')}
</section>`).join('\n')}
${faq.length ? `<section class="faq">
<h2>Questions</h2>
${faq.map(f => `<h3>${esc(f.q)}</h3>\n<p>${esc(f.a)}</p>`).join('\n')}
</section>` : ''}
<section>
<h2>Sources</h2>
<ul class="sources">
${C.SOURCES.map(s => `<li><a href="${esc(s.url)}" rel="noopener">${esc(s.label)}</a></li>`).join('\n')}
</ul>
</section>
<p class="cta"><a class="btn" href="../">Open Ranger Hawk</a></p>
</div>`;
    } else {
      main = `<div class="wrap page embed">
<h1>${esc(d.h1)}</h1>
${site[d.embed]}
</div>`;
    }
    out[fileOf(d.c.path)] = doc(staticHead({ title: d.c.title || '', description: d.c.description || fill(d.c.lead || ''), canonical: url, ld }, rel), rel, main, d.key);
  }

  /* ---- one page per water, from the app's static sheet without rewriting it */
  const indexCrumbs = (index, p) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
    { '@type': 'ListItem', position: 2, name: index.key === 'fishing' ? 'Fishing' : 'Hunting', item: SITE + index.hub.path },
    { '@type': 'ListItem', position: 3, name: index.label, item: SITE + index.c.path },
    ...(p ? [{ '@type': 'ListItem', position: 4, name: p.name, item: SITE + p.path }] : []),
  ] });
  const longDate = value => {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  };
  const edition = fishing.rules._edition, asOf = longDate(fishing.date);
  const sourceChange = a => `<p class="fine">Source: <a href="${esc(a.url)}" rel="noopener">Utah DWR emergency change, in force ${esc(longDate(a.from))} through ${esc(longDate(a.last_day))}</a></p>`;
  for (const p of waterDefs.pages) {
    const where = countyText(p.counties), rel = '../../../';
    let title = `${p.name} fishing rules, ${where}, Utah | Ranger Hawk`;
    if (title.length > 70) title = title.replace(', Utah |', ' |');
    let description = p.kind === 'notice'
      ? `Utah DWR's emergency change for ${p.name} (${where}), with the ${edition.year} statewide fishing limits.`
      : p.kind === 'community'
        ? `Utah DWR's ${edition.year} rules for ${p.name} (${where}), a community fishing water: the community rules, the statewide limits and any emergency change in force.`
        : `Utah DWR's ${edition.year} fishing rules for ${p.name} (${where}): its own rules, the statewide limits and any emergency change in force.`;
    if (description.length > 160) description = description.replace(` (${where})`, '');
    const lead = p.kind === 'notice'
      ? `${p.name}, ${where}. The ${edition.year} Utah fishing guidebook has no entry of its own for this water; these are Utah DWR's emergency change for it and the statewide limits, as of noon, ${asOf}. Apart from the emergency change, the statewide rules apply.`
      : `${p.name}, ${where}. Utah DWR's rules for this ${p.kind === 'community' ? 'community fishing water' : 'water'} from the ${edition.year} Utah fishing guidebook, page ${p.page}, with the statewide limits and any emergency change in force, as of noon, ${asOf}.`;
    const guidebookSource = p.kind === 'notice' ? '' : `<p class="fine">Source: <a href="${esc(edition.pdf)}#page=${esc(p.page)}" rel="noopener">${esc(edition.title)}, page ${esc(p.page)}</a></p>`;
    const sheet = fishing.render(p.id);
    if (!sheet) throw new BuildError('the fishing renderer returned no sheet for ' + p.id);
    const main = `<div class="wrap page embed">
<h1>${esc(p.name)}</h1>
<p class="lead">${esc(lead)}</p>
${sheet}
${guidebookSource}
${p.changes.map(sourceChange).join('\n')}
<p class="cta"><a class="btn" href="/?water=${esc(p.id)}">Open this water in Ranger Hawk</a></p>
</div>`;
    out[fileOf(p.path)] = doc(staticHead({ title, description, canonical: SITE + p.path, ld: [indexCrumbs(indexes[0], p)] }, rel), rel, main, 'fishing');
  }

  /* ---- each eligible hunt polygon, with its unchanged static unit sheet */
  const huntYear = hunting.config.hunt_year;
  const pulled = /\bpulled (\d{4}-\d{2}-\d{2})\b/.exec(hunting.HU._source || '');
  if (!pulled) throw new BuildError('the hunt boundary lists record no pull date');
  const huntEdition = hunting.HT._edition, oddsYear = Object.keys(hunting.ODDS.years).sort().pop();
  for (const p of unitDefs.pages) {
    const species = p.species.join(', '), rel = '../../../';
    let title = `${p.name} hunt unit, Utah: boundary and ${huntYear} hunts | Ranger Hawk`;
    if (title.length > 70) title = title.replace(', Utah', '');
    let description = `Utah DWR's ${huntYear} boundary description for the ${p.name} hunt unit (${species}), with its seasons and hunts from UDWR's lists and guidebooks.`;
    if (description.length > 160) description = description.replace(` (${species})`, '');
    const lead = `${p.name}, a Utah big game hunt unit: ${species}. Utah DWR's boundary description for each ${huntYear} hunt list that names this unit, with the unit's ${huntYear} seasons and hunts as Ranger Hawk reads them from UDWR's hunt lists, the ${huntYear} Big Game Field Regulations and the ${huntYear} Big Game Application Guidebook, as of noon, ${longDate(hunting.date)}.`;
    const sheet = hunting.render(p.id);
    if (!sheet) throw new BuildError('the unit renderer returned no sheet for ' + p.name);
    const main = `<div class="wrap page embed">
<h1>${esc(p.name)}</h1>
<p class="lead">${esc(lead)}</p>
${sheet}
<section>
<h2>Sources</h2>
<p class="fine">Source: Utah DWR's ${esc(huntYear)} hunt boundary lists, pulled ${esc(longDate(pulled[1]))}.</p>
<p class="fine">Source: <a href="${esc(huntEdition.pdf)}" rel="noopener">${esc(huntEdition.title)}, reissued ${esc(longDate(huntEdition.reissued))}.</a></p>
<p class="fine">Source: Utah DWR ${esc(huntYear)} Big Game Field Regulations Guidebook (general seasons).</p>
<p class="fine">Source: Utah DWR big game draw results, ${esc(oddsYear)}.</p>
</section>
<p class="cta"><a class="btn" href="/?unit=${esc(p.slug)}">Open this unit in Ranger Hawk</a></p>
</div>`;
    out[fileOf(p.path)] = doc(staticHead({ title, description, canonical: SITE + p.path,
      ld: [indexCrumbs(indexes[1], p)] }, rel), rel, main, 'hunting');
  }

  /* ---- every guidebook entry and community member, including pointers and
     inactive notice-only waters. Letter headings keep the long list readable. */
  for (const index of indexes) {
    const c = index.c, rel = '../../';
    let list = '', letter = '';
    for (const item of index.items) {
      const first = item.name.slice(0, 1).toLocaleUpperCase('en-US');
      if (first !== letter) {
        if (letter) list += '</ul>\n</section>\n';
        letter = first;
        list += `<section>\n<h2>${esc(letter)}</h2>\n<ul class="links">\n`;
      }
      /* A pointer says where the guidebook sends it, and the stretch when UDWR names one. */
      const see = item.kind === 'pointer' ? ` &mdash; see ${esc(item.targetName)}${item.targetReach ? ', ' + esc(item.targetReach) : ''}` : '';
      const detail = index.key === 'fishing' ? countyText(item.counties) : item.species.join(', ');
      list += `<li>${item.path ? `<a href="${esc(item.path)}">${esc(item.name)}</a>` : esc(item.name)}${detail ? ' &mdash; ' + esc(detail) : ''}${see}</li>\n`;
    }
    if (letter) list += '</ul>\n</section>\n';
    const lead = index.key === 'hunting' ? `<p class="lead">${esc(`Every polygon in Utah DWR's big game hunt boundary layer, A to Z, with the species each unit is listed for. A unit with no link is a polygon that none of the ${huntYear} hunt lists Ranger Hawk reads names.`)}</p>\n` : '';
    const main = `<div class="wrap page">\n<h1>${esc(c.label)}</h1>\n${lead}${list}</div>`;
    out[fileOf(c.path)] = doc(staticHead({ title: c.title, description: fill(c.description), canonical: SITE + c.path, ld: [indexCrumbs(index)] }, rel), rel, main, index.key);
  }

  /* ---- 404: served at any path, so every URL is root-absolute */
  {
    const n = C.NOT_FOUND;
    const links = [{ href: '/', label: 'Open Ranger Hawk' }, { href: '/hunting/', label: 'Hunting in Utah' }, { href: '/fishing/', label: 'Fishing in Utah' }];
    const main = `<div class="wrap page">
<h1>${esc(n.h1)}</h1>
<p class="lead">${esc(n.lead)}</p>
<ul class="links">
${links.map(l => `<li><a href="${l.href}">${esc(l.label)}</a></li>`).join('\n')}
</ul>
</div>`;
    out[path.join(DOCS, '404.html')] = doc(staticHead({ title: n.title, description: n.lead, noindex: true }, '/'), '/', main);
  }

  /* ---- sitemap.xml: no lastmod. The only thing that changes daily is the footer date, which is not a
     significant update to a page, so the sitemap does not claim one. */
  {
    const entries = ['/'].concat(defs.map(d => d.c.path), indexes.map(i => i.c.path), waterDefs.pages.map(p => p.path), unitDefs.pages.map(p => p.path));
    out[path.join(DOCS, 'sitemap.xml')] = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map(e => `  <url><loc>${SITE}${e}</loc></url>`).join('\n')}
</urlset>
`;
  }

  /* ---- llms.txt (llmstxt.org) */
  {
    const desc = d => fill(d.c.description || d.c.lead || '');
    out[path.join(DOCS, 'llms.txt')] = `# ${C.NAME}

> ${C.ONE_LINE}

${C.LLMS.details.map(fill).join('\n\n')}

${C.DISCLAIMER}

## Pages

${defs.map(d => `- [${d.label}](${SITE}${d.c.path}): ${desc(d)}`).join('\n')}
${indexes.map(i => `- [${i.c.label}](${SITE}${i.c.path}): ${fill(i.c.description)}`).join('\n')}

## Sources

${C.SOURCES.map(s => `- [${s.label}](${s.url})`).join('\n')}

## Optional

- [${FEED.label}](${FEED.url}): ${FEED.note}
`;
  }

  /* ---- docs/index.html: the seo region in <head> and the shell block in #view */
  {
    const p = path.join(DOCS, 'index.html');
    let html = fs.readFileSync(p, 'utf8');
    const graph = { '@context': 'https://schema.org', '@graph': [
      { '@type': 'Organization', '@id': SITE + '/#org', name: C.NAME, url: SITE + '/', logo: SITE + '/icons/icon-512.png' },
      { '@type': 'WebSite', '@id': SITE + '/#website', name: C.NAME, url: SITE + '/', description: C.ONE_LINE, inLanguage: 'en-US', publisher: { '@id': SITE + '/#org' } },
      { '@type': 'WebApplication', '@id': SITE + '/#app', name: C.NAME, url: SITE + '/', description: C.ONE_LINE,
        applicationCategory: C.APP.applicationCategory, operatingSystem: C.APP.operatingSystem,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, isAccessibleForFree: true,
        spatialCoverage: { '@type': 'State', name: 'Utah' }, inLanguage: 'en-US', publisher: { '@id': SITE + '/#org' }, image: OG_IMAGE },
    ] };
    const seo = [
      `<title>${esc(C.HOME.title)}</title>`,
      `<meta name="description" content="${esc(C.ONE_LINE)}">`,
      `<link rel="canonical" href="${SITE}/">`,
      ...ogTags({ title: C.HOME.title, description: C.ONE_LINE, url: SITE + '/' }),
      '<link rel="icon" href="favicon.ico" sizes="48x48">',
      '<link rel="icon" type="image/svg+xml" href="icons/favicon.svg">',
      ...fontPreloads(''),
      ldBlock(graph),
    ].join('\n');
    const links = [{ href: 'hunting/', label: 'Hunting in Utah' }, { href: 'fishing/', label: 'Fishing in Utah' }]
      .concat(C.ABOUT ? [{ href: 'about/', label: C.ABOUT.label || 'About' }] : [])
      .concat([{ href: 'privacy/', label: 'Privacy' }, { href: 'how-ranger-hawk-makes-money/', label: 'How Ranger Hawk makes money' }]);
    const shell = `<div class="card"><div class="card-b priv">
<p class="note">${esc(C.HOME.lead)}</p>
<ul>
${links.map(l => `<li><a href="${l.href}">${esc(l.label)}</a></li>`).join('\n')}
</ul>
</div></div>
<p class="fine">${esc(C.DISCLAIMER)}</p>`;
    html = replaceRegion(html, '<!-- seo:start -->', '<!-- seo:end -->', seo);
    html = replaceRegion(html, '<!-- shell:start -->', '<!-- shell:end -->', shell);
    out[p] = html;
  }

  /* ---- docs/manifest.webmanifest: three keys, nothing else touched */
  {
    const p = path.join(DOCS, 'manifest.webmanifest');
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(l => !/^  "(lang|categories)":/.test(l));
    const di = lines.findIndex(l => /^  "description":/.test(l));
    if (di < 0) throw new BuildError('docs/manifest.webmanifest has no "description" line to replace');
    lines[di] = `  "description": ${JSON.stringify(C.ONE_LINE)},`;
    lines.splice(di + 1, 0, '  "lang": "en-US",', '  "categories": ["sports", "navigation", "travel"],');
    const text = lines.join('\n');
    JSON.parse(text);
    out[p] = text;
  }

  /* ---- a {placeholder} anywhere in what we are about to write is a failed build */
  for (const f of Object.keys(out)) {
    const m = out[f].match(/\{[A-Za-z_][A-Za-z0-9_]*\}/);
    if (m) throw new BuildError(`${path.relative(ROOT, f)} still has ${m[0]}`);
  }
  /* An ended notice must no longer have a page after the next build. Only these
     known rule-id index files belong to this generator; leave any other files. */
  const possible = fishing.rules.waters.map(w => '/fishing/waters/' + w.id + '/')
    .concat(fishing.rules.community.members.map(m => '/fishing/community/' + m.id + '/'));
  for (const p of possible) {
    const f = fileOf(p);
    if (!Object.prototype.hasOwnProperty.call(out, f) && fs.existsSync(f)) {
      fs.unlinkSync(f);
      if (!fs.readdirSync(path.dirname(f)).length) fs.rmdirSync(path.dirname(f));
    }
  }
  const unitRoot = path.join(DOCS, 'hunting', 'units');
  if (fs.existsSync(unitRoot)) for (const dir of fs.readdirSync(unitRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const f = path.join(unitRoot, dir.name, 'index.html');
    if (!Object.prototype.hasOwnProperty.call(out, f) && fs.existsSync(f)) {
      fs.unlinkSync(f);
      if (!fs.readdirSync(path.dirname(f)).length) fs.rmdirSync(path.dirname(f));
    }
  }
  for (const f of Object.keys(out)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, out[f].endsWith('\n') || f.endsWith('.webmanifest') ? out[f] : out[f] + '\n');
  }
  return { counts, iso, date: fishing.date, fishing: waterDefs, hunting: unitDefs, files: Object.keys(out).map(f => path.relative(ROOT, f)).sort() };
}

function replaceRegion(html, start, end, inner) {
  const a = html.indexOf(start), b = html.indexOf(end);
  if (a < 0 || b < a) throw new BuildError(`docs/index.html is missing the ${start} ... ${end} markers`);
  return html.slice(0, a + start.length) + '\n' + inner + '\n' + html.slice(b);
}

module.exports = { build, loadSite, loadFishing, fishingPages, loadUnits, unitPages, utahDate, denverNoon, computeCounts, checkCounts, refreshDate, humanDate, BuildError };

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.some(a => !/^--date=\d{4}-\d{2}-\d{2}$/.test(a)) || args.length > 1) throw new BuildError('usage: node scraper/build_pages.js [--date=YYYY-MM-DD]');
    const r = build(args.length ? { date: args[0].slice(7) } : {});
    console.log('build_pages: counts ' + JSON.stringify(r.counts) + '; sources last checked ' + r.iso);
    console.log('build_pages: wrote ' + r.files.length + ' files: ' + r.files.join(', '));
  } catch (e) {
    if (!(e instanceof BuildError)) throw e;
    console.error('build_pages: FAIL ' + e.message);
    process.exit(1);
  }
}
