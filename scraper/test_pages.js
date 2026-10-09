#!/usr/bin/env node
/* Checks what scraper/build_pages.js writes: the static pages, the home page's head tags,
   the sitemap, llms.txt, the manifest, and docs/robots.txt. It runs the build twice,
   then reads the files back.

       node scraper/test_pages.js
*/
'use strict';
const fs = require('fs'), path = require('path');
const C = require('./pages/content.js');
const B = require('./build_pages.js');

const ROOT = path.resolve(__dirname, '..'), DOCS = path.join(ROOT, 'docs');
const SITE = C.SITE;
const read = rel => fs.readFileSync(path.join(DOCS, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(DOCS, rel));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail ? '\n       got ' + detail : ''));
}
const short = s => { s = String(s); return s.length > 140 ? s.slice(0, 137) + '...' : s; };

/* ---------------------------------------------------------------- build twice */
let counts, site, built = {};
try {
  const first = B.build();
  counts = first.counts;
  const snap = {};
  first.files.forEach(f => { snap[f] = fs.readFileSync(path.join(ROOT, f)); });
  const second = B.build();
  ok('the build writes the same files twice', JSON.stringify(first.files) === JSON.stringify(second.files));
  const differ = second.files.filter(f => !snap[f] || !snap[f].equals(fs.readFileSync(path.join(ROOT, f))));
  ok('the build is deterministic: a second run writes identical bytes', differ.length === 0, differ.join(', '));
  built = snap;
  site = B.loadSite();
} catch (e) {
  console.log('  FAIL the build did not run: ' + e.message);
  console.log('0 passed, 1 failed');
  process.exit(1);
}
const fill = s => String(s).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) => String(counts[k]));
const refresh = B.refreshDate(), refreshHuman = B.humanDate(refresh);

/* ------------------------------------------------------------------ helpers */
const entities = s => unesc(s);
function metaContent(html, attr, name) {
  const re = new RegExp('<meta ' + attr + '="' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '" content="([^"]*)">', 'g');
  return [...html.matchAll(re)].map(m => entities(m[1]));
}
const linkHrefs = (html, rel) => [...html.matchAll(new RegExp('<link rel="' + rel + '"[^>]*href="([^"]*)"', 'g'))].map(m => m[1]);
function ldBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/g)].map(m => m[1]);
}
function pngSize(rel) {
  const b = fs.readFileSync(path.join(DOCS, rel));
  if (b.slice(1, 4).toString() !== 'PNG') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
const fileForUrl = u => {
  const url = new URL(u, SITE + '/');
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  return p.replace(/^\//, '');
};
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
function balanced(html) {
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/g, '<script></script>');
  const stack = [];
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g)) {
    const closing = m[1] === '/', name = m[2].toLowerCase();
    if (VOID.has(name)) continue;
    if (!closing) { stack.push(name); continue; }
    const top = stack.pop();
    if (top !== name) return `</${name}> closes <${top || 'nothing'}> at offset ${m.index}`;
  }
  return stack.length ? 'unclosed <' + stack[stack.length - 1] + '>' : '';
}

/* ----------------------------------------------------------- what to expect */
const ARTICLES = [['hunting', C.HUNTING], ['fishing', C.FISHING]].concat(C.ABOUT ? [['about', Object.assign({ path: '/about/' }, C.ABOUT)]] : []);
const EMBEDS = [['privacy', C.PRIVACY, site.privacy, 'Privacy'], ['money', C.MONEY, site.money, 'How Ranger Hawk makes money']];
const STATIC = ARTICLES.map(([k, c]) => ({ key: k, c, kind: 'article' })).concat(EMBEDS.map(([k, c, body, h1]) => ({ key: k, c, kind: 'embed', body, h1 })));
const fileOf = p => p.replace(/^\/|\/$/g, '') + '/index.html';
const DESC = d => fill(d.c.description || d.c.lead);
const ALL_PAGES = [{ key: 'home', file: 'index.html', url: SITE + '/', title: C.HOME.title, desc: C.ONE_LINE }]
  .concat(STATIC.map(d => ({ key: d.key, file: fileOf(d.c.path), url: SITE + d.c.path, title: d.c.title, desc: DESC(d), d })));

/* ------------------------------------------------- every page: head and body */
for (const p of ALL_PAGES) {
  const n = p.key + ': ';
  ok(n + 'the file exists', exists(p.file));
  if (!exists(p.file)) continue;
  const html = read(p.file);
  ok(n + 'exactly one <title>, equal to the content', (html.match(/<title>/g) || []).length === 1 && html.includes('<title>' + esc(p.title) + '</title>'));
  const desc = metaContent(html, 'name', 'description');
  ok(n + 'exactly one meta description, equal to the content', desc.length === 1 && desc[0] === p.desc, short(desc.join('|')));
  ok(n + 'meta description is 160 characters or fewer', desc.length === 1 && desc[0].length <= 160, desc[0] && desc[0].length);
  const canon = linkHrefs(html, 'canonical');
  ok(n + 'one canonical, equal to the page address, absolute with a trailing slash', canon.length === 1 && canon[0] === p.url && canon[0].endsWith('/'), canon.join('|'));
  const ogUrl = metaContent(html, 'property', 'og:url');
  ok(n + 'og:url equals the canonical', ogUrl.length === 1 && ogUrl[0] === canon[0], ogUrl.join('|'));
  ok(n + 'og:title and og:description equal the page title and description', metaContent(html, 'property', 'og:title')[0] === p.title && metaContent(html, 'property', 'og:description')[0] === p.desc);
  ok(n + 'og:type website, og:site_name, og:locale en_US, twitter:card summary_large_image',
    metaContent(html, 'property', 'og:type')[0] === 'website' && metaContent(html, 'property', 'og:site_name')[0] === C.NAME &&
    metaContent(html, 'property', 'og:locale')[0] === 'en_US' && metaContent(html, 'name', 'twitter:card')[0] === 'summary_large_image');
  const img = metaContent(html, 'property', 'og:image')[0] || '';
  ok(n + 'og:image is an absolute https://rangerhawk.com/icons/ file that exists', img.startsWith(SITE + '/icons/') && exists(fileForUrl(img)), img);
  const dim = exists(fileForUrl(img)) ? pngSize(fileForUrl(img)) : null;
  ok(n + 'og:image:width and height match the picture (1200x630)', !!dim && dim.w === 1200 && dim.h === 630 &&
    metaContent(html, 'property', 'og:image:width')[0] === String(dim.w) && metaContent(html, 'property', 'og:image:height')[0] === String(dim.h), JSON.stringify(dim));
  ok(n + 'og:image:alt is set', (metaContent(html, 'property', 'og:image:alt')[0] || '').startsWith('Ranger Hawk: the hawk head mark'));
  ok(n + 'charset utf-8 and the viewport tag', html.includes('<meta charset="utf-8">') && html.includes('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'));
  ok(n + 'theme-color is the charcoal', metaContent(html, 'name', 'theme-color')[0] === '#2C2C2C');
  ok(n + 'the icon links are there and the files exist', linkHrefs(html, 'icon').length >= 2 && linkHrefs(html, 'icon').every(h => exists(fileForUrl(new URL(h, new URL(p.url)).href))));
  ok(n + 'the two font preloads', /<link rel="preload" href="[^"]*fonts\/ZillaSlab-700\.woff2" as="font" type="font\/woff2" crossorigin>/.test(html) && /<link rel="preload" href="[^"]*fonts\/PublicSans-var\.woff2" as="font" type="font\/woff2" crossorigin>/.test(html));
  const blocks = ldBlocks(html);
  let parsed = [];
  try { parsed = blocks.map(b => JSON.parse(b)); } catch (e) { ok(n + 'every JSON-LD block parses', false, e.message); }
  ok(n + 'has JSON-LD and every block has @context https://schema.org', parsed.length > 0 && parsed.length === blocks.length && parsed.every(j => j['@context'] === 'https://schema.org'));
  ok(n + 'JSON-LD claims no rating, review or social profile', !/aggregateRating|"review"|"sameAs"/.test(blocks.join('\n')));
  ok(n + 'no unfilled {placeholder}', !/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(html));
  ok(n + 'every tag is closed', balanced(html) === '', balanced(html));
  ok(n + 'no "noindex"', !/noindex/.test(html));

  if (p.key === 'home') continue;
  /* ---- the static pages */
  const d = p.d;
  ok(n + 'no <script src=, no counter pixel, no service worker', !/<script[^>]*\bsrc=/.test(html) && !/goatcounter\.com\/count|new Image|gc\.zgo\.at/i.test(html) && !/serviceWorker/.test(html));
  ok(n + 'only JSON-LD scripts', (html.match(/<script\b[^>]*>/g) || []).every(t => t === '<script type="application/ld+json">'));
  ok(n + 'styles.css then page.css, relative', html.indexOf('<link rel="stylesheet" href="../styles.css">\n<link rel="stylesheet" href="../page.css">') > 0);
  ok(n + 'one h1, and the charcoal header with the wordmark linking home', (html.match(/<h1>/g) || []).length === 1 &&
    html.includes('<header class="bar">') && html.includes('<a class="brand" href="../"><img src="../icons/rangerhawk-wordmark.svg" alt="Ranger Hawk" width="154" height="24"></a>'));
  ok(n + 'footer: the disclaimer, the four page links, the sources-checked date', html.includes('<footer>') && html.includes(esc(C.DISCLAIMER)) &&
    ['hunting/', 'fishing/', 'privacy/', 'how-ranger-hawk-makes-money/'].every(h => html.includes('<a href="../' + h + '"')) &&
    html.includes('<p>Sources last checked ' + refreshHuman + '.</p>'), refreshHuman);
  const crumbs = parsed.find(j => j['@type'] === 'BreadcrumbList');
  ok(n + 'BreadcrumbList: Home then this page', !!crumbs && crumbs.itemListElement.length === 2 && crumbs.itemListElement[0].item === SITE + '/' &&
    crumbs.itemListElement[0].name === 'Home' && crumbs.itemListElement[1].item === p.url);

  if (d.kind === 'article') {
    const c = d.c;
    ok(n + 'h1 and lead are the content words', html.includes('<h1>' + esc(fill(c.h1)) + '</h1>') && html.includes('<p class="lead">' + esc(fill(c.lead)) + '</p>'));
    ok(n + 'every section heading and paragraph is the content words', (c.sections || []).every(s => html.includes('<h2>' + esc(fill(s.h2)) + '</h2>') && s.p.every(t => html.includes('<p>' + esc(fill(t)) + '</p>'))));
    const want = (c.faq || []).map(f => ({ q: fill(f.q), a: fill(f.a) }));
    const sec = html.match(/<section class="faq">\n<h2>Questions<\/h2>\n([\s\S]*?)\n<\/section>/);
    ok(n + 'a visible Questions section (when there are questions)', want.length ? !!sec : !sec);
    const visible = sec ? [...sec[1].matchAll(/<h3>([\s\S]*?)<\/h3>\n<p>([\s\S]*?)<\/p>/g)].map(m => ({ q: unesc(m[1]), a: unesc(m[2]) })) : [];
    ok(n + 'the visible questions are the content questions', JSON.stringify(visible) === JSON.stringify(want));
    const faq = parsed.find(j => j['@type'] === 'FAQPage');
    const ldFaq = faq ? faq.mainEntity.map(e => ({ q: e.name, a: e.acceptedAnswer.text })) : [];
    ok(n + 'FAQPage text equals the visible questions, word for word', JSON.stringify(ldFaq) === JSON.stringify(visible) && (want.length > 0) === !!faq, short(JSON.stringify(ldFaq)));
    ok(n + 'a Sources list with plain links and rel="noopener"', C.SOURCES.every(s => html.includes('<li><a href="' + esc(s.url) + '" rel="noopener">' + esc(s.label) + '</a></li>')));
    ok(n + 'the Open Ranger Hawk button links to the app', html.includes('<a class="btn" href="../">Open Ranger Hawk</a>'));
    ok(n + 'Questions, then Sources, then the button, in that order', (!want.length || html.indexOf('<h2>Questions</h2>') < html.indexOf('<h2>Sources</h2>')) && html.indexOf('<h2>Sources</h2>') < html.indexOf('class="btn"'));
  } else {
    ok(n + 'h1 is "' + d.h1 + '"', html.includes('<h1>' + esc(d.h1) + '</h1>\n'));
    ok(n + 'the body is exactly what the in-app screen draws (site.js)', html.split(d.body).length === 2);
    ok(n + 'the screen sits after the h1, inside the page column', html.indexOf('<h1>' + esc(d.h1) + '</h1>\n' + d.body + '\n</div>') > 0);
    ok(n + 'no FAQPage on this page', !parsed.some(j => j['@type'] === 'FAQPage'));
  }
}

/* ------------------------------------------------------ the home page itself */
{
  const idx = read('index.html');
  ok('index.html: seo markers appear once each, in <head>', (idx.match(/<!-- seo:start -->/g) || []).length === 1 && (idx.match(/<!-- seo:end -->/g) || []).length === 1 &&
    idx.indexOf('<!-- seo:start -->') < idx.indexOf('<!-- seo:end -->') && idx.indexOf('<!-- seo:end -->') < idx.indexOf('</head>'));
  ok('index.html: shell markers appear once each, inside #view', idx.includes('<div class="wrap" id="view"><!-- shell:start -->') && idx.includes('<!-- shell:end --></div></main>'));
  const shell = (idx.match(/<!-- shell:start -->([\s\S]*?)<!-- shell:end -->/) || [])[1] || '';
  ok('index.html: the shell block has the lead, the four links and the disclaimer', shell.includes(esc(C.HOME.lead)) && shell.includes(esc(C.DISCLAIMER)) &&
    ['hunting/', 'fishing/', 'privacy/', 'how-ranger-hawk-makes-money/'].every(h => shell.includes('<a href="' + h + '">')));
  ok('index.html: nothing hides the shell block (no hidden, display:none, noscript, or style on it)', !/hidden|display\s*:\s*none|<noscript|style=/i.test(shell));
  ok('index.html: the old <title> and description are gone', (idx.match(/<title>/g) || []).length === 1 && metaContent(idx, 'name', 'description').length === 1);
  ok('index.html: the existing tags stay outside the markers', ['<meta name="theme-color" content="#2C2C2C">', '<meta name="apple-mobile-web-app-capable" content="yes">', '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">', '<link rel="apple-touch-icon" href="icons/icon-180.png">', '<link rel="stylesheet" href="styles.css">']
    .every(t => idx.indexOf(t) > idx.indexOf('<!-- seo:end -->')));
  const srcs = [...idx.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  ok('index.html: state.js is the first <script src>, app.js after it', srcs[0] === 'state.js' && srcs.indexOf('app.js') > 0, srcs.join(','));
  ok('index.html: go.js and site.js stay adjacent', idx.includes('<script src="go.js"></script>\n<script src="site.js"></script>'));
  ok('index.html: the only other script is JSON-LD, in <head>', (idx.match(/<script\b[^>]*>/g) || []).filter(t => !/\bsrc=/.test(t)).every(t => t === '<script type="application/ld+json">') &&
    ldBlocks(idx).length === 1 && idx.indexOf('<script type="application/ld+json">') < idx.indexOf('</head>'));
  const g = JSON.parse(ldBlocks(idx)[0])['@graph'] || [];
  const by = t => g.find(x => x['@type'] === t) || {};
  ok('index.html: Organization, WebSite and WebApplication', ['Organization', 'WebSite', 'WebApplication'].every(t => g.some(x => x['@type'] === t)) && g.length === 3);
  ok('index.html: the @ids are #org, #website, #app and the publisher points at #org', by('Organization')['@id'] === SITE + '/#org' && by('WebSite')['@id'] === SITE + '/#website' &&
    by('WebApplication')['@id'] === SITE + '/#app' && by('WebSite').publisher['@id'] === SITE + '/#org' && by('WebApplication').publisher['@id'] === SITE + '/#org');
  const wa = by('WebApplication');
  ok('index.html: WebApplication is free, Utah, en-US, with the category and system from content.js', wa.offers.price === '0' && wa.offers.priceCurrency === 'USD' && wa.isAccessibleForFree === true &&
    wa.spatialCoverage['@type'] === 'State' && wa.spatialCoverage.name === 'Utah' && !('areaServed' in wa) && wa.inLanguage === 'en-US' && wa.applicationCategory === C.APP.applicationCategory &&
    wa.operatingSystem === C.APP.operatingSystem && wa.image === SITE + '/icons/og-image.png');
  ok('index.html: Organization logo is icon-512 and exists', by('Organization').logo === SITE + '/icons/icon-512.png' && exists('icons/icon-512.png'));
  const app = fs.readFileSync(path.join(DOCS, 'app.js'), 'utf8');
  ok('app.js: the first draw replaces #view wholesale, so the shell block goes', /function render\(\) \{[\s\S]*?\$\('view'\)\.innerHTML = v\(\);/.test(app));
}

/* ------------------------------------------------- the 404 (served at any path) */
{
  const h = read('404.html');
  const n = '404: ';
  ok(n + 'noindex, one title, a description, no canonical', h.includes('<meta name="robots" content="noindex">') && (h.match(/<title>/g) || []).length === 1 &&
    metaContent(h, 'name', 'description').length === 1 && linkHrefs(h, 'canonical').length === 0);
  ok(n + 'the content words', h.includes('<h1>' + esc(C.NOT_FOUND.h1) + '</h1>') && h.includes(esc(C.NOT_FOUND.lead)) && h.includes('<title>' + esc(C.NOT_FOUND.title) + '</title>'));
  ok(n + 'links to the home page, /hunting/ and /fishing/', ['<a href="/">', '<a href="/hunting/">', '<a href="/fishing/">'].every(t => h.includes(t)));
  const urls = [...h.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1]).filter(u => !/^(https?:|mailto:|#)/.test(u));
  ok(n + 'every internal URL is root-absolute', urls.length > 5 && urls.every(u => u.startsWith('/')), urls.filter(u => !u.startsWith('/')).join(','));
  ok(n + 'styles.css and page.css by absolute path, no scripts', h.includes('href="/styles.css"') && h.includes('href="/page.css"') && !/<script[^>]*\bsrc=/.test(h) && !/goatcounter\.com\/count|gc\.zgo\.at|serviceWorker/i.test(h));
  ok(n + 'every tag is closed, no {placeholder}', balanced(h) === '' && !/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(h), balanced(h));
  ok(n + 'footer has the disclaimer and the sources-checked date', h.includes(esc(C.DISCLAIMER)) && h.includes('<p>Sources last checked ' + refreshHuman + '.</p>'));
}

/* ---------------------------- every internal link and file reference resolves */
{
  const pages = ['index.html', '404.html'].concat(STATIC.map(d => fileOf(d.c.path)));
  const bad = [];
  for (const f of pages) {
    const base = f === 'index.html' ? SITE + '/' : f === '404.html' ? SITE + '/404.html' : SITE + '/' + f.replace(/index\.html$/, '');
    for (const m of read(f).matchAll(/(?:href|src)="([^"]+)"/g)) {
      const u = m[1];
      if (/^(mailto:|tel:|data:|#|javascript:)/.test(u)) continue;
      const abs = new URL(u, base);
      if (abs.origin !== SITE) continue;
      if (!exists(fileForUrl(abs.href))) bad.push(f + ' -> ' + u);
    }
  }
  ok('every same-site href and src in the built pages points at a file in docs/', bad.length === 0, bad.join('; '));
  ok('page.css exists and the wordmark and fonts the pages preload exist', exists('page.css') && exists('icons/rangerhawk-wordmark.svg') && exists('fonts/ZillaSlab-700.woff2') && exists('fonts/PublicSans-var.woff2'));
}

/* --------------------------------------------------------------- sitemap.xml */
{
  const x = read('sitemap.xml');
  const rows = [...x.matchAll(/<url><loc>([^<]+)<\/loc>(<lastmod>([^<]+)<\/lastmod>)?<\/url>/g)].map(m => ({ loc: m[1], lastmod: m[3] || null }));
  const want = ['/'].concat(STATIC.map(d => d.c.path)).map(p => SITE + p);
  ok('sitemap: lists exactly the built pages, home first', JSON.stringify(rows.map(r => r.loc)) === JSON.stringify(want), rows.map(r => r.loc).join(' '));
  ok('sitemap: a valid urlset', x.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">') && x.trimEnd().endsWith('</urlset>') && (x.match(/<url>/g) || []).length === rows.length);
  ok('sitemap: no lastmod anywhere (the daily footer date is not a significant update)', !/lastmod/.test(x) && rows.every(r => r.lastmod === null));
  ok('sitemap: every address maps to a file in docs/', rows.every(r => exists(fileForUrl(r.loc))));
  ok('sitemap: the 404 is not listed', !x.includes('404'));
}

/* ------------------------------------------------------------------ llms.txt */
{
  const t = read('llms.txt');
  ok('llms.txt: "# Ranger Hawk", then "> " + the one-line description', t.startsWith('# ' + C.NAME + '\n\n> ' + C.ONE_LINE + '\n\n'));
  ok('llms.txt: the detail paragraphs, then the disclaimer', C.LLMS.details.every(d => t.includes(fill(d))) && t.indexOf(C.LLMS.details[0]) < t.indexOf(C.DISCLAIMER) && t.indexOf(C.DISCLAIMER) < t.indexOf('## Pages'));
  const heads = [...t.matchAll(/^## (.+)$/gm)].map(m => m[1]);
  ok('llms.txt: sections are Pages, Sources, Optional', JSON.stringify(heads) === JSON.stringify(['Pages', 'Sources', 'Optional']), heads.join(','));
  const pagesSec = (t.match(/## Pages\n\n([\s\S]*?)\n\n## Sources/) || [])[1] || '';
  const pageLines = pagesSec.split('\n');
  ok('llms.txt: each page is "- [label](absolute url): its description"', pageLines.length === STATIC.length && STATIC.every((d, i) => {
    const m = pageLines[i].match(/^- \[([^\]]+)\]\((https:\/\/[^)]+)\): (.+)$/);
    return !!m && m[2] === SITE + d.c.path && m[3] === DESC({ c: d.c });
  }), pagesSec);
  ok('llms.txt: Sources lists every source', C.SOURCES.every(s => t.includes('- [' + s.label + '](' + s.url + ')')));
  ok('llms.txt: Optional has the calendar feed', t.includes('## Optional\n\n- [Calendar feed (hunt.ics)](' + SITE + '/hunt.ics): every Utah hunting deadline as a calendar feed\n'));
  const links = [...t.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map(m => m[1]).filter(u => u.startsWith(SITE));
  ok('llms.txt: every rangerhawk.com link maps to a file in docs/', links.length >= 5 && links.every(u => exists(fileForUrl(u))), links.filter(u => !exists(fileForUrl(u))).join(' '));
  ok('llms.txt: no raw data files linked, no {placeholder}', !/data\/ut|\.json|\.pmtiles/.test(t) && !/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(t));
}

/* ----------------------------------------------------------------- robots.txt */
{
  ok('robots.txt: exists', exists('robots.txt'));
  const r = exists('robots.txt') ? read('robots.txt') : '';
  ok('robots.txt: names the sitemap', /^Sitemap: https:\/\/rangerhawk\.com\/sitemap\.xml$/m.test(r) && exists('sitemap.xml'));
  const groups = [];
  let cur = null, lastWasRule = true;
  for (const raw of r.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'sitemap') { lastWasRule = true; continue; }
    if (key === 'user-agent') {
      if (lastWasRule || !cur) { cur = { agents: [], allow: [], disallow: [] }; groups.push(cur); }
      cur.agents.push(m[2]); lastWasRule = false;
    } else if (cur) {
      if (key === 'allow') cur.allow.push(m[2]); else if (key === 'disallow') cur.disallow.push(m[2]); else cur.other = true;
      lastWasRule = true;
    }
  }
  ok('robots.txt: has groups, one of them for *', groups.length >= 1 && groups.some(g => g.agents.includes('*')), groups.length + ' groups');
  ok('robots.txt: every User-agent group has "Allow: /" and "Disallow: /maps/" and no other Disallow line',
    groups.every(g => g.allow.includes('/') && g.disallow.length === 1 && g.disallow[0] === '/maps/'),
    JSON.stringify(groups.filter(g => !(g.allow.includes('/') && g.disallow.length === 1 && g.disallow[0] === '/maps/'))));
}

/* ------------------------------------------------------------------ manifest */
{
  const raw = read('manifest.webmanifest'), m = JSON.parse(raw);
  const keys = Object.keys(m);
  ok('manifest: description is the one-line description, plus lang and categories', m.description === C.ONE_LINE && m.lang === 'en-US' && JSON.stringify(m.categories) === JSON.stringify(['sports', 'navigation', 'travel']));
  ok('manifest: no "id" (the app keeps its identity)', !('id' in m));
  ok('manifest: key order kept, lang and categories follow description', JSON.stringify(keys) === JSON.stringify(['name', 'short_name', 'description', 'lang', 'categories', 'start_url', 'scope', 'display', 'orientation', 'background_color', 'theme_color', 'icons']), keys.join(','));
  ok('manifest: start_url, scope, colours and the four icons are as they were', m.start_url === './index.html' && m.scope === './' && m.theme_color === '#2C2C2C' && m.background_color === '#2C2C2C' &&
    m.icons.length === 4 && m.icons.every(i => exists(i.src)));
}

/* ------------------------------------------ the one-line description, everywhere */
{
  const idx = read('index.html'), g = JSON.parse(ldBlocks(idx)[0])['@graph'];
  const sites = g.filter(x => x['@type'] === 'WebSite' || x['@type'] === 'WebApplication').map(x => x.description);
  const llms = read('llms.txt'), man = JSON.parse(read('manifest.webmanifest'));
  ok('ONE_LINE: under 155 characters', C.ONE_LINE.length < 155, C.ONE_LINE.length);
  ok('ONE_LINE: identical in the meta description, og:description, WebSite, WebApplication, the manifest and llms.txt',
    metaContent(idx, 'name', 'description')[0] === C.ONE_LINE && metaContent(idx, 'property', 'og:description')[0] === C.ONE_LINE &&
    sites.length === 2 && sites.every(s => s === C.ONE_LINE) && man.description === C.ONE_LINE && llms.split('\n')[2] === '> ' + C.ONE_LINE);
}

/* --------------------------------------------------------------- the counts */
{
  ok('the five counts the pages use are whole numbers above zero', Object.keys(counts).length === 5 && Object.values(counts).every(n => Number.isInteger(n) && n > 0), JSON.stringify(counts));
  for (const bad of [0, -1, 1.5, NaN, undefined]) {
    let msg = '';
    try { B.checkCounts(Object.assign({}, counts, { fish_places: bad })); } catch (e) { msg = e.message; }
    ok('the build stops when a count is ' + bad, /fish_places is /.test(msg), msg);
  }
  let fine = true;
  try { B.checkCounts(counts); } catch (e) { fine = false; }
  ok('the build goes ahead on the data counts', fine);
  ok('content.js uses only placeholders with a count', [...JSON.stringify(C).matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].every(m => m[1] in counts));
}

/* ------------------------------------- the disclaimer is the money screen's sentence */
{
  const siteSrc = fs.readFileSync(path.join(DOCS, 'site.js'), 'utf8');
  ok('DISCLAIMER occurs verbatim in docs/site.js', siteSrc.includes(C.DISCLAIMER));
  ok('DISCLAIMER occurs verbatim in vMoney() output', site.money.includes(C.DISCLAIMER));
  ok('every built page carries the DISCLAIMER verbatim (as HTML text)', ['index.html', '404.html'].concat(STATIC.map(d => fileOf(d.c.path))).every(f => read(f).includes(esc(C.DISCLAIMER))));
}

/* ------------------------------------------------------------- wording sweep */
{
  const WORDS = /\b(official(?:ly)?|verified|licensed|endorsed|certified|guarantee[ds]?)\b/gi;
  const NEGATION = 'not part of, or endorsed by';   // the disclaimer; the FAQ answers say it without the comma and are allowed the same way
  const sources = [];
  const walk = (v, p) => { if (typeof v === 'string') sources.push(['content.js ' + p, v]); else if (Array.isArray(v)) v.forEach((x, i) => walk(x, p + '[' + i + ']')); else if (v && typeof v === 'object') Object.keys(v).forEach(k => walk(v[k], p + '.' + k)); };
  walk(C, '');
  ['index.html', '404.html', 'sitemap.xml', 'llms.txt', 'manifest.webmanifest'].concat(STATIC.map(d => fileOf(d.c.path))).forEach(f => sources.push([f, read(f)]));
  const seen = new Map();
  const bad = [];
  for (const [name, text] of sources) {
    for (const m of text.matchAll(WORDS)) {
      const at = m.index, word = m[1].toLowerCase();
      const allowed = word === 'endorsed' && /not part of,? or endorsed by$/.test(text.slice(Math.max(0, at - 20), at + m[1].length + 3));
      const ctx = text.slice(Math.max(0, at - 28), at + m[1].length + 18).replace(/\s+/g, ' ');
      const key = (allowed ? 'allowed' : 'FAIL') + ' | ' + ctx;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(name);
      if (!allowed) bad.push(name + ': ..' + ctx + '..');
    }
  }
  for (const [key, files] of seen) console.log('  wording: ' + key + '   [' + files.length + ' place' + (files.length === 1 ? '' : 's') + ': ' + [...new Set(files)].slice(0, 3).join(', ') + (new Set(files).size > 3 ? ', ...' : '') + ']');
  ok('wording sweep: no "official", "verified", "licensed", "endorsed", "certified" or "guarantee" outside the disclaimer\'s own negation', bad.length === 0, bad.join('; '));
  ok('wording sweep: the negation itself is in the disclaimer', C.DISCLAIMER.includes(NEGATION));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
