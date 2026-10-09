#!/usr/bin/env node
/* Builds the static pages that sit beside the app, and the search plumbing for them.

       node scraper/build_pages.js

   Reads  scraper/pages/content.js   every sentence the pages say (one source)
          docs/data/ut/*.json        the counts and the data refresh date
          docs/state.js + site.js    the Privacy and Money screens, loaded the way the browser loads them
   Writes docs/hunting/index.html, docs/fishing/index.html, docs/privacy/index.html,
          docs/how-ranger-hawk-makes-money/index.html, docs/404.html, docs/sitemap.xml,
          docs/llms.txt (and docs/about/index.html if content.js ever exports ABOUT)
   Edits  two marked regions of docs/index.html (seo, shell) and three keys of
          docs/manifest.webmanifest (description, lang, categories).

   Same inputs, same bytes: nothing here reads the clock. A count that is not a whole
   number above zero stops the build (see checkCounts), and so does a {placeholder} left
   in any output. Run before the tests; refresh.yml does. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const C = require('./pages/content.js');

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

function build() {
  const counts = computeCounts();
  checkCounts(counts);
  const fill = s => String(s).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) => {
    if (!Object.prototype.hasOwnProperty.call(counts, k)) throw new BuildError(`content.js uses ${m} and build_pages.js has no count of that name`);
    return String(counts[k]);
  });
  const iso = refreshDate(), human = humanDate(iso);
  const site = loadSite();
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
      const faq = (c.faq || []).map(f => ({ q: fill(f.q), a: fill(f.a) }));
      if (faq.length) ld.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
      main = `<div class="wrap page">
<h1>${esc(fill(c.h1))}</h1>
<p class="lead">${esc(fill(c.lead))}</p>
${(c.sections || []).map(s => `<section>
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
    const entries = ['/'].concat(defs.map(d => d.c.path));
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
        areaServed: { '@type': 'State', name: 'Utah' }, inLanguage: 'en-US', publisher: { '@id': SITE + '/#org' }, image: OG_IMAGE },
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
  for (const f of Object.keys(out)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, out[f].endsWith('\n') || f.endsWith('.webmanifest') ? out[f] : out[f] + '\n');
  }
  return { counts, iso, files: Object.keys(out).map(f => path.relative(ROOT, f)).sort() };
}

function replaceRegion(html, start, end, inner) {
  const a = html.indexOf(start), b = html.indexOf(end);
  if (a < 0 || b < a) throw new BuildError(`docs/index.html is missing the ${start} ... ${end} markers`);
  return html.slice(0, a + start.length) + '\n' + inner + '\n' + html.slice(b);
}

module.exports = { build, loadSite, computeCounts, checkCounts, refreshDate, humanDate, BuildError };

if (require.main === module) {
  try {
    const r = build();
    console.log('build_pages: counts ' + JSON.stringify(r.counts) + '; sources last checked ' + r.iso);
    console.log('build_pages: wrote ' + r.files.length + ' files: ' + r.files.join(', '));
  } catch (e) {
    if (!(e instanceof BuildError)) throw e;
    console.error('build_pages: FAIL ' + e.message);
    process.exit(1);
  }
}
