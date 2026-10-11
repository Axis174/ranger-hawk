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
const unesc = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&mdash;/g, '—').replace(/&amp;/g, '&');
/* Stop the build on one Utah date even if the tests cross midnight. The builder
   receives the date explicitly, so the determinism check is about that date's
   pages rather than two separate readings of the clock. */
const BUILD_DATE = (() => {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day;
})();

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail ? '\n       got ' + detail : ''));
}
const short = s => { s = String(s); return s.length > 140 ? s.slice(0, 137) + '...' : s; };

/* ---------------------------------------------------------------- build twice */
let counts, site, fishing, generated, builtDate, built = {};
try {
  const first = B.build({ date: BUILD_DATE });
  counts = first.counts;
  builtDate = first.date;
  const snap = {};
  first.files.forEach(f => { snap[f] = fs.readFileSync(path.join(ROOT, f)); });
  const second = B.build({ date: BUILD_DATE });
  ok('the build writes the same files twice', JSON.stringify(first.files) === JSON.stringify(second.files));
  const differ = second.files.filter(f => !snap[f] || !snap[f].equals(fs.readFileSync(path.join(ROOT, f))));
  ok('the build is deterministic: a second run writes identical bytes', differ.length === 0, differ.join(', '));
  built = snap;
  site = B.loadSite();
  fishing = B.loadFishing(BUILD_DATE);
  generated = first.fishing;
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

/* Expectations below come from the input fields. They deliberately do not use
   fishingPages()'s lead, metadata or Source strings as their expected values. */
const R = fishing.rules, P = fishing.places;
const countyNames = e => (e.counties || [e.county]).concat((P.extra_counties || {})[e.id] || []);
/* How a page says its counties, from the fields: the sheet header's words (fishing.js, sheetFishWater).
   One county reads "Summit County"; several read "Summit, Utah, Wasatch counties". */
const countyLine = names => names.join(', ') + (names.length > 1 ? ' counties' : ' County');
const keptChanges = (id, loader = fishing) => loader.rules.amendments.filter(a =>
  (a.community ? 'community:' + a.community : a.water) === id && ['on', 'later'].includes(loader.amendState(a).k)
).sort((a, b) => a.from.localeCompare(b.from));
const longDate = iso => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
};
const WATER_PAGES = R.waters.filter(w => w.kind === 'water' || (w.kind === 'notice' && keptChanges(w.id).length))
  .map(w => ({ kind: w.kind, id: w.id, entry: w, path: '/fishing/waters/' + w.id + '/', page: w.page }));
const TWIN_IDS = new Set(R.waters.filter(w => w.kind === 'water').map(w => w.id));
const COMMUNITY_PAGES = R.community.members.filter(m => !TWIN_IDS.has(m.id))
  .map(m => ({ kind: 'community', id: 'community:' + m.id, entry: m, path: '/fishing/community/' + m.id + '/', page: R.community.page }));
const FISH_PAGES = WATER_PAGES.concat(COMMUNITY_PAGES);
const FISH_FILES = ['fishing/waters/index.html'].concat(FISH_PAGES.map(p => fileOf(p.path)));
/* The statewide table a page shows is the app's: fishing.js drops the 'community' row (the community rules
   speak for it) and the 'kokanee' row (folded into the trout row, "Trout, kokanee salmon and Arctic grayling"). */
const DROPPED_ROWS = R.statewide.limits.filter(l => l.row === 'community' || l.row === 'kokanee');
const APP_ROWS = R.statewide.limits.filter(l => l.row !== 'community' && l.row !== 'kokanee');
const plain = html => unesc(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
/* The lead's second exception covers these UDWR fields, wherever nested. Keep
   their paths and rule ids for the hand-back; heads and all other prose stay
   swept. Longest first avoids removing only part of a longer quoted string.
   The third adds everything UDWR's list contributes that a page can print
   (fishing_notices.json): fStale prints a notice's title, a notice's text lines are
   printed by fEntryHtml and fStale, and the list's other lines (headings and closing
   lines, other[]) are what fStale prints as "New on it" when they are new. All of it is
   UDWR's text exactly as a rule is, and it arrives overnight, so it must never stop the
   night's refresh. */
function quotedRuleFields(rules, notices) {
  const out = [];
  const add = (text, field, id) => { if (typeof text === 'string' && text) out.push({ text, field, id: id || null }); };
  const rule = (r, field) => {
    add(r.text, field + '.text', r.id);
    (r.items || []).forEach((text, i) => add(text, field + '.items[' + i + ']', r.id));
  };
  const walk = (v, field) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v.rules)) v.rules.forEach((r, i) => rule(r, field + '.rules[' + i + ']'));
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, field + '[' + i + ']'));
    else Object.entries(v).forEach(([key, x]) => walk(x, field ? field + '.' + key : key));
  };
  walk(rules, '');
  ((rules.spear || {}).general || []).forEach((r, i) => rule(r, 'spear.general[' + i + ']'));
  ((rules.community || {}).notes || []).forEach((r, i) => add(r.text, 'community.notes[' + i + '].text', r.id));
  add((rules.community || {}).intro, 'community.intro');
  const strings = (v, field) => {
    if (typeof v === 'string') add(v, field);
    else if (Array.isArray(v)) v.forEach((x, i) => strings(x, field + '[' + i + ']'));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([key, x]) => strings(x, field + '.' + key));
  };
  strings(rules.rows || [], 'rows');
  strings((rules.statewide || {}).limits || [], 'statewide.limits');
  ((notices || {}).notices || []).forEach((n, i) => {
    add(n.title, 'notices[' + i + '].title', n.slug);
    (n.text || []).forEach((line, j) => add(line[1], 'notices[' + i + '].text[' + j + ']', n.slug));
  });
  ((notices || {}).other || []).forEach((line, i) => add(line[1], 'notices.other[' + i + ']'));
  return out.sort((a, b) => b.text.length - a.text.length);
}
const RULE_FIELDS = quotedRuleFields(R, fishing.notices);
const ruleTexts = fields => [...new Set(fields.map(f => f.text))].sort((a, b) => b.length - a.length);
const RULE_TEXTS = ruleTexts(RULE_FIELDS);
function withoutQuotedRules(html, quotes = RULE_TEXTS, intro = R.community.intro) {
  const remove = text => quotes.reduce((s, quote) => s.split(esc(quote)).join(' '), text);
  /* Remove exact escaped quotes only where the renderer prints rules or table
     values. A matching string in a lead, title, head, index, banner or footer
     must still fail. Nested date spans contain Ranger Hawk's own wording.
     The banners that may hold UDWR's words are the four that print what UDWR's list
     contributes (last replace below): a notice for this water (its text lines), the
     list of changes not yet built in (their titles), a reworded notice (its title and
     lines) and the list that is not the list the rules were built from ("New on it":
     lines of other[]). Only the exact UDWR strings go from those; the banner's own
     sentences stay swept. */
  return html.replace(/(<span class="ftext">)([\s\S]*?)(<\/span>)/g, (_, start, body, end) => {
    const at = body.indexOf('<span');
    return start + (at < 0 ? remove(body) : remove(body.slice(0, at)) + body.slice(at)) + end;
  }).replace(/(<table class="flim(?: chg)?">)([\s\S]*?)(<\/table>)/g, (_, start, body, end) =>
    start + body.replace(/(<td>)([^<]*)([\s\S]*?<\/td>)/g, (__, td, value, rest) => td + remove(value) + rest) + end
  ).replace(/(<div class="fwhere">)([\s\S]*?)(<\/div>)/g, (_, start, body, end) =>
    start + (quotes.includes(intro) && body === esc(intro) ? ' ' : body) + end
  ).replace(/(<div class="warnbox fbad"[^>]*>)(<b>UDWR(?: has (?:posted|reworded)|'s list of fishing changes)[\s\S]*?)(<\/div>)/g, (_, start, body, end) =>
    start + remove(body) + end);
}
const WORDS = /\b(official(?:ly)?|verified|licensed|endorsed|certified|guarantee[ds]?)\b/gi;
const wordingHits = text => [...text.matchAll(WORDS)].filter(m => !(m[1].toLowerCase() === 'endorsed' &&
  /not part of,? or endorsed by$/.test(text.slice(Math.max(0, m.index - 20), m.index + m[1].length + 3))));
/* What a page says about the clock outside UDWR's words: the visible text, with the quoted UDWR strings removed. */
const TEMPORAL = /\b(now|today|days left|tomorrow|Last day today)\b/gi;
const temporalHits = (html, quotes) => plain(withoutQuotedRules(html, quotes)).match(TEMPORAL) || [];

/* ------------------------------------- UDWR quotes versus Ranger Hawk claims */
{
  const synthetic = B.loadFishing(BUILD_DATE), id = 'flaming-gorge-reservoir-daggett';
  const rule = { id: 'synthetic-quote', head: 'A synthetic heading', page: 9, waters: [id], fx: [{ t: 'info' }],
    text: 'A synthetic official and licensed rule, now and today, with <fish> & water.',
    items: ['A synthetic official and licensed bullet, now and today, with <fish> & water.'] };
  synthetic.rules.statewide.rules.push(rule);
  const unused = 'An unprinted official and licensed UDWR string.';
  synthetic.rules.statewide.rules.push({ id: 'synthetic-unused', text: unused, items: [], waters: [], fx: [{ t: 'info' }] });
  /* The notices UDWR lists are collected too: if one is unread tonight, this sheet prints it, and it is UDWR's text. */
  const fields = quotedRuleFields(synthetic.rules, synthetic.notices), quotes = ruleTexts(fields);
  const sheet = synthetic.render(id);
  const page = '<title>A synthetic title</title><p class="lead">A synthetic lead</p>' + sheet;
  const stripped = withoutQuotedRules(page, quotes, synthetic.rules.community.intro);
  ok('UDWR sweep exception: synthetic rule text and bullet are escaped and verbatim on the page',
    page.includes(esc(rule.text)) && page.includes(esc(rule.items[0])));
  ok('UDWR sweep exception: quoted official/licensed text and bullet pass the wording sweep', wordingHits(stripped).length === 0);
  ok('UDWR sweep exception: quoted now/today text and bullet pass the temporal sweep', !/\b(now|today|days left|tomorrow)\b/i.test(plain(stripped)));
  for (const [where, html] of [
    ['lead', '<p class="lead">official licensed</p>'],
    ['title', '<title>official licensed</title>'],
    ['index', '<li><a href="/fishing/waters/">official licensed</a></li>'],
  ]) {
    ok('UDWR sweep exception: official/licensed in a ' + where + ' still fail',
      wordingHits(withoutQuotedRules(html + sheet, quotes)).length === 2);
  }
  rule.head = 'official licensed';
  ok('UDWR sweep exception: official/licensed in rules[].head still fail',
    wordingHits(withoutQuotedRules(synthetic.render(id), quotes)).length === 2);
  ok('UDWR sweep exception: unprinted UDWR text exempts nothing, even an identical lead',
    !sheet.includes(esc(unused)) && wordingHits(withoutQuotedRules('<p class="lead">' + esc(unused) + '</p>' + sheet, quotes)).length === 2);
  for (const [where, html] of [
    ['title', '<title>' + esc(rule.text) + '</title>'],
    ['head', '<span class="ftopic">' + esc(rule.text) + '</span>'],
    ['index', '<li>' + esc(rule.items[0]) + '</li>'],
  ]) {
    ok('UDWR sweep exception: an identical quote in a Ranger Hawk ' + where + ' still fails',
      wordingHits(withoutQuotedRules(html + sheet, quotes)).length === 2);
  }
  const collected = new Set(RULE_FIELDS.map(f => f.field));
  ok('UDWR sweep exception: items, notes, intro and both table arrays are collected',
    ['statewide.rules[7].items[1]', 'community.notes[0].text', 'community.intro', 'rows[0].name', 'statewide.limits[0].limit'].every(f => collected.has(f)));
  ok('UDWR sweep exception: emergency and spearfishing rule text stays covered',
    ['amendments[0].rules[0].text', 'spear.general[0].text', 'spear.sections[2].entries[2].rules[0].text'].every(f => collected.has(f)));
  ok('UDWR sweep exception: no rules[].head receives an exemption', RULE_FIELDS.every(f => !f.field.endsWith('.head')));
}

/* -------------------------- UDWR's listed notices versus Ranger Hawk claims */
{
  /* A notice UDWR lists but nobody has read into the rules yet is printed word for word, and one that
     arrives overnight must not stop the night's refresh because it says "now", "today", "official" or
     "licensed". Three notices, each printed the way the renderer prints one: unread and named for this
     water (its text lines are printed on the sheet); unread and for another water (its title is
     printed in the list of changes not yet built in); read into the rules and since reworded (its
     title and lines are printed in the reworded banner). The list's own lines (other[]) are printed
     as "New on it" when the rules have not seen them: one new heading, and one the rules have seen
     (which is not printed and so exempts nothing). */
  const synthetic = B.loadFishing(BUILD_DATE), id = 'flaming-gorge-reservoir-daggett';
  const water = synthetic.rules.waters.find(w => w.id === id), county = water.counties[0];
  const said = 'official, licensed, now and today';
  const notice = (slug, name, c, lines) => ({ slug, url: 'https://wildlife.utah.gov/pdf/guidebooks/emergency-changes/' + slug + '.pdf', title: name + ' (' + c + ' County): ' + said,
    name, county: c, text: lines, from: '2026-10-01', until: '2026-12-31', sha: 'after', pdf_sha: 'after', pdf_bytes: 1 });
  const here = notice('synthetic-here', water.name, county, [['p', 'A synthetic official and licensed notice, in force now and today, with <fish> & water.'], ['li', 'A synthetic bullet: official, licensed, now, today.']]);
  const elsewhere = notice('synthetic-elsewhere', 'Synthetic Other Water', 'Nowhere', [['p', 'A synthetic official and licensed notice for another water, now and today.']]);
  const reworded = notice('synthetic-reworded', 'Synthetic Third Water', 'Nowhere', [['p', 'A synthetic official and licensed reworded notice, now and today.'], ['li', 'A synthetic reworded bullet: official, licensed, now, today.']]);
  synthetic.notices.notices.push(here, elsewhere, reworded);
  const fresh = 'Synthetic heading: official changes are in force now', seen = 'Seen heading: official, in force now';
  synthetic.notices.other = (synthetic.notices.other || []).concat([['h', fresh], ['h', seen]]);
  synthetic.rules._notices_other = (synthetic.rules._notices_other || []).concat([seen]);
  synthetic.rules.amendments.push({ notice: reworded.slug, url: reworded.url, name: reworded.name, county: reworded.county, water: 'synthetic-nowhere', from: '2020-01-01', until: '2020-01-02', last_day: '2020-01-02', direction: 'less', rules: [], sha: 'before', pdf_sha: 'before' });
  const quotes = ruleTexts(quotedRuleFields(synthetic.rules, synthetic.notices)), without = ruleTexts(quotedRuleFields(synthetic.rules));
  /* Every notice and every line the real list has, but not the two synthetic list lines: what still fails is theirs alone. */
  const noSynthetic = ruleTexts(quotedRuleFields(synthetic.rules, { notices: synthetic.notices.notices, other: fishing.notices.other }));
  const sheet = synthetic.render(id), page = '<title>A synthetic title</title><p class="lead">A synthetic lead</p>' + sheet;
  const printed = [...here.text.map(t => t[1]), elsewhere.title, reworded.title, ...reworded.text.map(t => t[1])];
  ok('UDWR notice exception: the three notices are printed escaped and verbatim, as UDWR wrote them', printed.every(t => sheet.includes(esc(t))) && sheet.includes('&lt;fish&gt; &amp; water.'));
  ok('UDWR notice exception: the other notice\'s text and this water\'s title are not printed, so they exempt nothing', !sheet.includes(esc(elsewhere.text[0][1])) && !sheet.includes(esc(here.title)));
  ok('UDWR notice exception: without the exemption the same page fails both sweeps', wordingHits(withoutQuotedRules(page, without)).length > 0 && temporalHits(page, without).length > 0);
  ok('UDWR notice exception: with it, official/licensed pass the wording sweep', wordingHits(withoutQuotedRules(page, quotes)).length === 0);
  ok('UDWR notice exception: with it, now/today pass the clock sweep', temporalHits(page, quotes).length === 0, temporalHits(page, quotes).join(', '));
  ok('UDWR notice exception: a new line on UDWR\'s list is printed as "New on it", escaped and verbatim; a line the rules have seen is not printed', sheet.includes('New on it:') && sheet.includes('"' + esc(fresh) + '"') && !sheet.includes(esc(seen)));
  ok('UDWR notice exception: without the new synthetic list line exempted, that line alone still fails (one official, one now)', wordingHits(withoutQuotedRules(page, noSynthetic)).length === 1 && temporalHits(page, noSynthetic).length === 1);
  const claim = 'Ranger Hawk is official and licensed, now and today';
  for (const [where, html, words = 2, clock = 2] of [
    ['lead', '<p class="lead">' + claim + '</p>'],
    ['title', '<title>' + claim + '</title>'],
    ['index', '<li><a href="/fishing/waters/">' + claim + '</a></li>'],
    ['sentence in a notice banner', '<div class="warnbox fbad" style="margin:12px 16px 0"><b>UDWR has posted a change for this water that is not built into the rules below.</b> ' + claim + '.</div>'],
    ['sentence in the banner for a changed list', '<div class="warnbox fbad" style="margin:12px 16px 0"><b>UDWR\'s list of fishing changes is not the list these rules were built from.</b> ' + claim + '.</div>'],
    ['lead that repeats a printed notice line', '<p class="lead">' + esc(here.text[0][1]) + '</p>'],
    ['lead that repeats a notice line that is not printed', '<p class="lead">' + esc(elsewhere.text[0][1]) + '</p>'],
    ['lead that repeats a new line of UDWR\'s list', '<p class="lead">' + esc(fresh) + '</p>', 1, 1],
    ['lead that repeats a line of UDWR\'s list that is not printed', '<p class="lead">' + esc(seen) + '</p>', 1, 1],
  ]) {
    ok('UDWR notice exception: official/licensed in a Ranger Hawk ' + where + ' still fail the wording sweep', wordingHits(withoutQuotedRules(html + sheet, quotes)).length === words);
    ok('UDWR notice exception: now/today in a Ranger Hawk ' + where + ' still fail the clock sweep', temporalHits(html + sheet, quotes).length === clock);
  }
  const fields = RULE_FIELDS.map(f => f.field), listed = (fishing.notices.notices || []), others = (fishing.notices.other || []);
  ok('UDWR notice exception: every listed notice\'s title and text lines, and every other line of UDWR\'s list, are collected', listed.every((n, i) => (!n.title || fields.includes('notices[' + i + '].title')) && (n.text || []).every((t, j) => !t[1] || fields.includes('notices[' + i + '].text[' + j + ']'))) && others.every((line, i) => !line[1] || fields.includes('notices.other[' + i + ']')));
}

/* ---------------------------------------- pages drawn by the fishing renderer */
{
  const builtPaths = generated.pages.map(p => p.path).sort(), expectedPaths = FISH_PAGES.map(p => p.path).sort();
  ok('water pages: exactly the data-selected water, notice and community paths', JSON.stringify(builtPaths) === JSON.stringify(expectedPaths));
  ok('water pages: the build date is the explicit Utah date', BUILD_DATE === builtDate);
  const byKind = kind => FISH_PAGES.filter(p => p.kind === kind).length;
  console.log('  water pages: ' + byKind('water') + ' water, ' + byKind('notice') + ' notice, ' + byKind('community') + ' community; as of noon ' + BUILD_DATE);

  for (const p of FISH_PAGES) {
    const f = fileOf(p.path), n = p.id + ': ', e = p.entry, where = countyLine(countyNames(e)), changes = keptChanges(p.id);
    ok(n + 'the static page exists', exists(f));
    if (!exists(f)) continue;
    const html = read(f), text = plain(html), url = SITE + p.path;
    const lead = p.kind === 'notice'
      ? `${e.name}, ${where}. The ${R._edition.year} Utah fishing guidebook has no entry of its own for this water; these are Utah DWR's emergency change for it and the statewide limits, as of noon, ${longDate(BUILD_DATE)}. Apart from the emergency change, the statewide rules apply.`
      : `${e.name}, ${where}. Utah DWR's rules for this ${p.kind === 'community' ? 'community fishing water' : 'water'} from the ${R._edition.year} Utah fishing guidebook, page ${p.page}, with the statewide limits and any emergency change in force, as of noon, ${longDate(BUILD_DATE)}.`;
    let title = `${e.name} fishing rules, ${where}, Utah | Ranger Hawk`;
    if (title.length > 70) title = `${e.name} fishing rules, ${where} | Ranger Hawk`;
    let description = p.kind === 'notice'
      ? `Utah DWR's emergency change for ${e.name} (${where}), with the ${R._edition.year} statewide fishing limits.`
      : p.kind === 'community'
        ? `Utah DWR's ${R._edition.year} rules for ${e.name} (${where}), a community fishing water: the community rules, the statewide limits and any emergency change in force.`
        : `Utah DWR's ${R._edition.year} fishing rules for ${e.name} (${where}): its own rules, the statewide limits and any emergency change in force.`;
    if (description.length > 160) description = description.replace(` (${where})`, '');
    ok(n + 'one guidebook-name h1 and the exact field-built lead', (html.match(/<h1>/g) || []).length === 1 && html.includes('<h1>' + esc(e.name) + '</h1>') && html.includes('<p class="lead">' + esc(lead) + '</p>'));
    ok(n + 'the static sheet appears unchanged after the lead', html.includes(esc(lead) + '</p>\n' + fishing.render(p.id)));
    ok(n + 'all own rules and stretch labels are escaped and verbatim', (e.reaches || []).every(reach => (reach.rules || []).every(rule => html.includes(esc(rule.text))) && (!reach.where || html.includes(esc(reach.where)))));
    const member = R.community.members.find(m => m.id === e.id);
    ok(n + 'community pages and the twin carry every shared rule and applicable note', !member || R.community.rules.concat((R.community.notes || []).filter(note => (note.members || []).includes(member.id))).every(rule => html.includes(esc(rule.text))));
    const tables = [...html.matchAll(/<table class="flim(?: chg)?">([\s\S]*?)<\/table>/g)].map(m => m[1]).join('');
    const rows = [...tables.matchAll(/<tr><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><\/tr>/g)];
    ok(n + 'the ' + APP_ROWS.length + ' statewide rows the app shows appear once with the statewide figure, and no others', rows.length === APP_ROWS.length && APP_ROWS.every(l => rows.filter(row => row[1].startsWith(esc(l.name)) && plain(row[2]).replace(/^statewide: /, '') === l.limit).length === 1), rows.length + ' rows');
    ok(n + 'the kokanee and community rows appear in no table (the app folds them into the trout row and the community rules)', DROPPED_ROWS.length === 2 && DROPPED_ROWS.every(l => !rows.some(row => row[1].startsWith(esc(l.name)))), rows.map(row => plain(row[1])).join(' | '));
    const temporal = temporalHits(html);
    ok(n + 'no relative clock wording outside verbatim rules', temporal.length === 0, temporal.join(', '));
    ok(n + 'no buttons, app data attributes, external scripts or executable JavaScript', !/<button\b|\bdata-fw\b|\bdata-fp\b|<script[^>]*\bsrc\s*=/i.test(html) && (html.match(/<script\b[^>]*>/g) || []).every(t => t === '<script type="application/ld+json">'));
    ok(n + 'no drive minutes, rule chips or reopening countdown lines', !/class="fchipline"|\b(?:min drive|minutes away|drive minutes|Last day open)\b|class="fdates">Opens\b/i.test(withoutQuotedRules(html)));
    ok(n + 'title follows the field template and 70-character fallback', (html.match(/<title>/g) || []).length === 1 && html.includes('<title>' + esc(title) + '</title>'));
    ok(n + 'description follows the field template and 160-character fallback', JSON.stringify(metaContent(html, 'name', 'description')) === JSON.stringify([description]));
    ok(n + 'canonical and og:url are absolute and end in a slash', JSON.stringify(linkHrefs(html, 'canonical')) === JSON.stringify([url]) && JSON.stringify(metaContent(html, 'property', 'og:url')) === JSON.stringify([url]) && url.endsWith('/'));
    ok(n + 'og:title, description and image match the hubs', metaContent(html, 'property', 'og:title')[0] === title && metaContent(html, 'property', 'og:description')[0] === description && metaContent(html, 'property', 'og:image')[0] === metaContent(read('fishing/index.html'), 'property', 'og:image')[0]);
    let ld = [];
    try { ld = ldBlocks(html).map(block => JSON.parse(block)); } catch (err) { ok(n + 'JSON-LD parses', false, err.message); }
    const crumbs = ld[0] && ld[0].itemListElement;
    ok(n + 'only BreadcrumbList structured data, Home > Fishing > Every water > water', ld.length === 1 && ld[0]['@context'] === 'https://schema.org' && ld[0]['@type'] === 'BreadcrumbList' && !!crumbs && JSON.stringify(crumbs.map(c => [c.position, c.name, c.item])) === JSON.stringify([[1, 'Home', SITE + '/'], [2, 'Fishing', SITE + '/fishing/'], [3, 'Every water', SITE + '/fishing/waters/'], [4, e.name, url]]));
    ok(n + 'header, footer and disclaimer use the shared template', html.includes('<header class="bar">') && /<a class="brand" href="(?:\.\.\/){3}"><img/.test(html) && html.includes('<footer>') && html.includes(esc(C.DISCLAIMER)) && html.includes('<p>Sources last checked ' + refreshHuman + '.</p>'));
    ok(n + 'every tag is closed and there are no placeholders', balanced(html) === '' && !/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(html), balanced(html));
    const sourceLines = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].filter(m => /^Source:/.test(plain(m[1])));
    if (p.kind === 'notice') {
      ok(n + 'notice lead has no page number and page has no guidebook-PDF link', !/\bpage \d+\b/i.test(lead) && !html.includes(esc(R._edition.pdf)));
      ok(n + 'notice has one Source per kept change and no guidebook Source', sourceLines.length === changes.length);
    } else {
      ok(n + 'the guidebook Source links to the field page', sourceLines.some(m => m[1].includes('href="' + esc(R._edition.pdf + '#page=' + p.page) + '"')) && sourceLines.length === changes.length + 1);
    }
    ok(n + 'each kept change has its dated Source and escaped verbatim rules', changes.every(a => sourceLines.some(m => plain(m[1]) === `Source: Utah DWR emergency change, in force ${longDate(a.from)} through ${longDate(a.last_day)}` && m[1].includes('href="' + esc(a.url) + '"')) && a.rules.every(rule => html.includes(esc(rule.text)))));
    ok(n + 'no ended change is cited', R.amendments.filter(a => fishing.amendState(a).k === 'ended').every(a => !sourceLines.some(m => m[1].includes('href="' + esc(a.url) + '"'))));
    const deep = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>Open this water in Ranger Hawk<\/a>/g)].map(m => new URL(unesc(m[1]), url));
    ok(n + 'Open this water links to its known app id after the Sources', deep.length === 1 && deep[0].origin === SITE && deep[0].pathname === '/' && deep[0].searchParams.get('water') === p.id && html.lastIndexOf('Source:') < html.lastIndexOf('Open this water in Ranger Hawk'));
  }
}

/* ------------------------------------------------------ every-water A-Z index */
{
  const html = read('fishing/waters/index.html'), items = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(m => m[1]);
  const targetPath = w => '/fishing/waters/' + (w.kind === 'pointer' ? w.see.water : w.id) + '/';
  /* A community member that is also a guidebook water (Burraston Ponds) is listed once: its water entry is its line. */
  const indexItems = R.waters.map(w => ({ entry: w, path: w.kind === 'notice' && !keptChanges(w.id).length ? null : targetPath(w) }))
    .concat(R.community.members.filter(m => !TWIN_IDS.has(m.id)).map(m => ({ entry: m, path: '/fishing/community/' + m.id + '/' })));
  /* A line reads "<name> — <county text>", and a pointer's adds "— see <target>[, <stretch>]". */
  const lineOf = item => { const parts = plain(item).split(' — '); return { name: parts[0], where: parts[1], rest: parts.slice(2).join(' — ') }; };
  ok('water index: every entry and community member is named with its county text and expected link, and only a pointer says more', indexItems.every(({ entry, path: href }) => items.some(item => {
    const l = lineOf(item);
    return l.name === entry.name && l.where === countyLine(countyNames(entry)) && (entry.kind === 'pointer' || l.rest === '') && (href ? item.includes('href="' + href + '"') : !/<a\b/.test(item));
  })));
  ok('water index: a pointer has no page; its line says "see <target>" and the stretch UDWR names, and links to the target', R.waters.filter(w => w.kind === 'pointer').every(w => {
    const target = R.waters.find(x => x.id === w.see.water);
    const stretches = target.reaches.filter(r => (w.see.reaches || []).includes(r.key) && r.where).map(r => r.where);
    const says = 'see ' + target.name + (stretches.length ? ', ' + stretches.join('; ') : '');
    return !exists('fishing/waters/' + w.id + '/index.html') && items.some(item => {
      const l = lineOf(item);
      return l.name === w.name && l.where === countyLine(countyNames(w)) && l.rest === says && item.includes('href="' + targetPath(w) + '"');
    });
  }));
  const burraston = 'burraston-ponds-juab', twin = R.waters.find(w => w.id === burraston);
  ok('water index: Burraston Ponds has exactly one page, at its water path', exists('fishing/waters/' + burraston + '/index.html') && !exists('fishing/community/' + burraston + '/index.html') && FISH_PAGES.filter(p => p.entry.id === burraston).length === 1);
  ok('water index: Burraston Ponds is listed once, as the water entry, linking to that page', items.filter(item => lineOf(item).name === twin.name).length === 1 && items.some(item => lineOf(item).name === twin.name && item.includes('href="/fishing/waters/' + burraston + '/"')));
  ok('water index: its title and description are the content words', html.includes('<title>' + esc(C.FISHING.waterIndex.title) + '</title>') && JSON.stringify(metaContent(html, 'name', 'description')) === JSON.stringify([C.FISHING.waterIndex.description]));
  const indexDesc = metaContent(html, 'name', 'description');
  ok('water index: its meta description is 160 characters or fewer, so a search snippet shows it whole', indexDesc.length === 1 && indexDesc[0].length <= 160, indexDesc[0] && indexDesc[0].length);
  const letters = [...html.matchAll(/<h2[^>]*>([A-Z])<\/h2>/g)].map(m => m[1]);
  const expectedLetters = [...new Set(indexItems.map(p => p.entry.name[0].toUpperCase()))].sort();
  ok('water index: alphabetical letter headings', JSON.stringify(letters) === JSON.stringify(expectedLetters));
  const listBody = (html.match(/<main>([\s\S]*?)<\/main>/) || [])[1] || '';
  const names = [...listBody.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(m => plain(m[1]).split(' — ')[0]);
  const expectedNames = indexItems.map(p => p.entry.name).sort((a, b) => a.localeCompare(b, 'en-US'));
  ok('water index: every name occurs A to Z', JSON.stringify(names) === JSON.stringify(expectedNames));
  ok('water index: hub links Every water, A to Z', read('fishing/index.html').includes('Every water, A to Z') && read('fishing/index.html').includes('href="/fishing/waters/"'));
  ok('water index: one h1, shared disclaimer, no buttons or external scripts', (html.match(/<h1>/g) || []).length === 1 && html.includes(esc(C.DISCLAIMER)) && !/<button\b|<script[^>]*\bsrc=/i.test(html));
}

/* ----------------------------------- the packet's Oct. 9 notice-only example */
{
  try {
    const onOct9 = B.loadFishing('2026-10-09'), output = B.build({ date: '2026-10-09' });
    for (const [id, example] of [['red-creek-reservoir-duchesne', true], ['crouse-reservoir-uintah', true], ['vernon-reservoir-tooele', false]]) {
      const selected = keptChanges(id, onOct9).length > 0;
      if (selected !== example) console.log('  packet notice fact differs from data: ' + id + ' page=' + selected + ' on 2026-10-09 (packet ' + example + ')');
      ok('Oct. 9 notice example: ' + id + ' follows actual fAmendState data', output.fishing.pages.some(p => p.id === id) === selected && exists('fishing/waters/' + id + '/index.html') === selected);
    }
  } catch (err) { ok('Oct. 9 notice example build succeeds', false, err.message); }
  finally { B.build({ date: BUILD_DATE }); }
  ok('notice example restores every current-date build byte', Object.keys(built).every(f => fs.readFileSync(path.join(ROOT, f)).equals(built[f])));
}

/* ------------------- a build on either side of the edition year: the year-end banner */
{
  /* On 1 January the pages must not break the night's refresh: the banner names the date the new
     guidebook governs from instead of saying "now", and a page built before the edition year says
     when the rules take effect instead of quoting the phone's date. Both sweeps run on every fishing
     page of each build. The two dates move with the edition: 2027-01-02 and 2025-12-31 for 2026. */
  const year = R._edition.year;
  try {
    for (const [date, says] of [
      [(year + 1) + '-01-02', `The ${year + 1} guidebook governs from January 1, ${year + 1}.`],
      [(year - 1) + '-12-31', `They take effect January 1, ${year}. This page was built before then; do not rely on them yet.`],
    ]) {
      const output = B.build({ date }), index = 'fishing/waters/index.html';
      const files = [index].concat(output.fishing.pages.map(p => fileOf(p.path)));
      const words = [], clock = [], banner = [], rows = [], phone = [];
      for (const f of files) {
        const html = read(f), hits = wordingHits(withoutQuotedRules(html)), told = temporalHits(html);
        if (hits.length) words.push(f + ': ' + hits.map(m => m[1]).join(', '));
        if (told.length) clock.push(f + ': ' + told.join(', '));
        if (f === index) continue;
        if (!html.includes(esc(says))) banner.push(f);
        if (/governs now|phone's date/.test(html)) phone.push(f);
        const table = [...html.matchAll(/<table class="flim(?: chg)?">([\s\S]*?)<\/table>/g)].map(m => m[1]).join('');
        const tr = [...table.matchAll(/<tr><td>([\s\S]*?)<\/td><td>/g)].map(m => m[1]);
        if (tr.length !== APP_ROWS.length || DROPPED_ROWS.some(l => tr.some(r => r.startsWith(esc(l.name))))) rows.push(f + ' (' + tr.length + ' rows)');
      }
      console.log('  year boundary: ' + date + ' builds ' + (files.length - 1) + ' water pages and the index; the banner reads "' + says + '"');
      ok(date + ': the build is for that Utah date and writes the index and water pages', output.date === date && files.length > 100 && files.every(f => exists(f)));
      ok(date + ': every fishing page passes the wording sweep outside UDWR\'s text', words.length === 0, words.slice(0, 3).join('; '));
      ok(date + ': every fishing page passes the clock sweep (no now, today, days left, tomorrow) outside UDWR\'s text', clock.length === 0, clock.slice(0, 3).join('; '));
      ok(date + ': every water page names the date from the fields: "' + says + '"', banner.length === 0, banner.slice(0, 3).join(', '));
      ok(date + ': no page says the new guidebook governs "now" or quotes the phone\'s date', phone.length === 0, phone.slice(0, 3).join(', '));
      ok(date + ': every water page shows the app\'s ' + APP_ROWS.length + ' statewide rows and neither the kokanee nor the community row', rows.length === 0, rows.slice(0, 3).join(', '));
    }
  } catch (err) { ok('year boundary builds succeed', false, err.message); }
  finally { B.build({ date: BUILD_DATE }); }
  ok('year boundary builds restore every current-date build byte', Object.keys(built).every(f => fs.readFileSync(path.join(ROOT, f)).equals(built[f])));
}

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
  const pages = ['index.html', '404.html'].concat(STATIC.map(d => fileOf(d.c.path)), FISH_FILES);
  const knownIds = new Set(R.waters.map(w => w.id).concat(R.community.members.map(m => 'community:' + m.id)));
  const bad = [];
  for (const f of pages) {
    const base = f === 'index.html' ? SITE + '/' : f === '404.html' ? SITE + '/404.html' : SITE + '/' + f.replace(/index\.html$/, '');
    for (const m of read(f).matchAll(/(?:href|src)="([^"]+)"/g)) {
      const u = m[1];
      if (/^(mailto:|tel:|data:|#|javascript:)/.test(u)) continue;
      const abs = new URL(u, base);
      if (abs.origin !== SITE) continue;
      if (abs.searchParams.has('water') && (abs.pathname !== '/' || !knownIds.has(abs.searchParams.get('water')))) bad.push(f + ' -> unknown app water ' + u);
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
  const want = ['/'].concat(STATIC.map(d => d.c.path), ['/fishing/waters/'], generated.pages.map(p => p.path)).map(p => SITE + p);
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
  ok('llms.txt: each page is "- [label](absolute url): its description"', pageLines.length === STATIC.length + 1 && STATIC.every((d, i) => {
    const m = pageLines[i].match(/^- \[([^\]]+)\]\((https:\/\/[^)]+)\): (.+)$/);
    return !!m && m[2] === SITE + d.c.path && m[3] === DESC({ c: d.c });
  }), pagesSec);
  ok('llms.txt: the index is the only additional fishing page under Pages', pageLines.filter(line => line.includes(SITE + '/fishing/waters/')).length === 1 && pageLines.some(line => line.includes('- [Every water, A to Z](' + SITE + '/fishing/waters/): ')) && !/\/fishing\/(?:waters|community)\/[a-z0-9-]+\//.test(pagesSec));
  ok('llms.txt: the index line carries the index description', pageLines.includes('- [' + C.FISHING.waterIndex.label + '](' + SITE + C.FISHING.waterIndex.path + '): ' + C.FISHING.waterIndex.description));
  const indexLine = pageLines.find(line => line.startsWith('- [' + C.FISHING.waterIndex.label + '](')) || '', indexLineText = indexLine.slice(indexLine.indexOf('): ') + 3);
  ok('llms.txt: the description on the index line is 160 characters or fewer', indexLine !== '' && indexLineText.length <= 160, indexLineText.length);
  ok('llms.txt: Sources lists every source', C.SOURCES.every(s => t.includes('- [' + s.label + '](' + s.url + ')')));
  ok('llms.txt: Optional has the calendar feed', t.includes('## Optional\n\n- [Calendar feed (hunt.ics)](' + SITE + '/hunt.ics): every Utah hunting deadline as a calendar feed\n'));
  const links = [...t.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map(m => m[1]).filter(u => u.startsWith(SITE));
  ok('llms.txt: every rangerhawk.com link maps to a file in docs/', links.length >= 5 && links.every(u => exists(fileForUrl(u))), links.filter(u => !exists(fileForUrl(u))).join(' '));
  ok('llms.txt: no raw data files linked, no {placeholder}', !/data\/ut|\.json|\.pmtiles/.test(t) && !/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(t));
}

/* ------------------------------------- what the pages say an unread notice does */
{
  const fish = read('fishing/index.html').replace(/<[^>]+>/g, ' '), t = read('llms.txt');
  ok('fishing page: a new emergency change is flagged and shown unread, and the rest keeps refreshing', /flagged in the job.s log and shown in the app as unread/.test(fish) && /rest of the data keeps refreshing every night/.test(fish));
  ok('llms.txt says the same', /flagged in the job.s log and shown in the app as unread/.test(t) && /rest of the data keeps refreshing every night/.test(t));
  ok('no page says a new emergency change holds the day\'s update', !/emergency change[^.;]*holds the day/.test(fish) && !/emergency change[^.;]*holds the day/.test(t) && !/Either one holds/.test(fish));
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
  ok('every built page carries the DISCLAIMER verbatim (as HTML text)', ['index.html', '404.html'].concat(STATIC.map(d => fileOf(d.c.path)), FISH_FILES).every(f => read(f).includes(esc(C.DISCLAIMER))));
}

/* ------------------------------------------------------------- wording sweep */
{
  const NEGATION = 'not part of, or endorsed by';   // the disclaimer; the FAQ answers say it without the comma and are allowed the same way
  const sources = [];
  const walk = (v, p) => { if (typeof v === 'string') sources.push(['content.js ' + p, v]); else if (Array.isArray(v)) v.forEach((x, i) => walk(x, p + '[' + i + ']')); else if (v && typeof v === 'object') Object.keys(v).forEach(k => walk(v[k], p + '.' + k)); };
  walk(C, '');
  ['index.html', '404.html', 'sitemap.xml', 'llms.txt', 'manifest.webmanifest'].concat(STATIC.map(d => fileOf(d.c.path))).forEach(f => sources.push([f, read(f)]));
  FISH_FILES.forEach(f => sources.push([f, withoutQuotedRules(read(f))]));
  for (const { text, field, id } of RULE_FIELDS) {
    const words = [...text.matchAll(WORDS)].map(m => m[1]);
    if (!words.length) continue;
    const quoted = FISH_FILES.filter(f => withoutQuotedRules(read(f), [text]) !== read(f));
    if (quoted.length) console.log('  UDWR verbatim wording exception: ' + field + ' | rule id ' + (id || '(none)') + ' | ' + words.join(', ') + '   [' + quoted.length + ' page' + (quoted.length === 1 ? '' : 's') + ': ' + quoted.slice(0, 3).join(', ') + (quoted.length > 3 ? ', ...' : '') + ']');
  }
  const seen = new Map();
  const bad = [];
  for (const [name, text] of sources) {
    const invalid = new Set(wordingHits(text).map(m => m.index));
    for (const m of text.matchAll(WORDS)) {
      const at = m.index, allowed = !invalid.has(at);
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
