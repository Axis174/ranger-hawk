/* Every sentence the static pages, the home page's head and llms.txt say.

   One source so the name, the one-line description and the disclaimer read the
   same in the page titles, Open Graph, JSON-LD, the manifest and llms.txt;
   scraper/test_pages.js holds them equal. {curly} names are filled from
   docs/data/ut at build time by build_pages.js, so a count is never typed by hand.

   Wording rules (README, "Search and AI search"): Ranger Hawk is not the state.
   Never claim it is official, verified or licensed, or that a hunt or a catch is
   legal. Rule text is the agency's, dated. Utah only. Nothing in structured data
   that is not true today: no ratings, reviews or follower counts. */

const SITE = 'https://rangerhawk.com';

const NAME = 'Ranger Hawk';

// The most-read sentence on the site: meta description, og:description, JSON-LD,
// manifest, llms.txt summary. Under 155 characters.
const ONE_LINE = 'Free Utah hunting and fishing app: seasons, hunt units, draw odds, fishing rules, access and offline maps, with the rules in Utah DWR’s words.';

// The in-app money screen's own words (site.js, "What Ranger Hawk is not"),
// verbatim; test_pages.js holds them equal.
const DISCLAIMER = 'Ranger Hawk is an independent app. It is not part of, or endorsed by, the Utah Division of Wildlife Resources or any other agency. It shows the agencies\' words and points to their pages. It is not legal advice: confirm with the agency before you hunt or fish.';

const SOURCES = [
  { label: 'Utah DWR guidebooks', url: 'https://wildlife.utah.gov/guidebooks' },
  { label: 'Utah Hunt Planner', url: 'https://hunt.utah.gov/' },
  { label: 'Utah fishing guidebook (PDF)', url: 'https://wildlife.utah.gov/guidebooks/fishing_guidebook.pdf' },
];

const HOME = {
  path: '/',
  title: 'Ranger Hawk: Utah hunting and fishing rules, seasons, maps',
  // Shown in index.html before the app draws its first screen, and to anyone
  // reading without JavaScript. The same words people see, never crawler-only.
  lead: 'Utah hunting and fishing seasons, rules, access and maps on your phone, with the rules in Utah DWR’s own words. Free, no account, and it works with no signal.',
};

const HUNTING = {
  path: '/hunting/',
  title: 'Utah hunting seasons, units, draw odds, access | Ranger Hawk',
  description: 'Every Utah bird, deer, elk and turkey season with what is open today, the hunts that exist where you want to go, draw odds for your points, offline maps.',
  h1: 'Utah hunting, in one free app',
  lead: 'Ranger Hawk is a free phone app for hunting in Utah. It shows every bird, deer, elk and turkey season with whether it is open today, finds the hunts that exist where you want to go, shows Utah DWR’s published draw results for your points, and maps access and hunt units with no signal.',
  sections: [
    { h2: 'Seasons and deadlines',
      p: ['Every season for birds, deer, elk and turkey, with its live open or closed state, and the next deadline as a countdown. A calendar feed puts every deadline in your phone’s own calendar.'] },
    { h2: 'Find a hunt',
      p: ['Type a sentence such as “elk near Heber with a rifle” and get the hunts that exist there this year, matched to Utah DWR’s hunt unit lists and draw results. When something is missing it asks, and it says why it answered what it did. It is a keyword reader, not an AI service, and it needs no signal.'] },
    { h2: 'Draw odds',
      p: ['Pick the draw, the species, resident or nonresident, and your points, and see what happened last year to people with your points, from Utah DWR’s published draw results. Bonus and random permits are shown separately. Your points stay on your phone.'] },
    { h2: 'Access',
      p: ['{access_points} bird hunting access points, nearest first from a Utah town you choose. Each one opens to its season dates, restrictions, required permits, contact and source.'] },
    { h2: 'Maps that work with no signal',
      p: ['All of Utah on one map: roads, dirt two-tracks, trails, Utah DWR properties, Walk-In Access, big game hunt unit lines, legal forest roads, BLM travel rules and land ownership. Tap anywhere for the property and hunt units at that spot. Tap Save map once and the map never needs a connection; the GPS button follows you with no signal.',
          '“Where am I” names the big game hunt boundaries you are standing in and the closest access points.'] },
    { h2: 'Trip plan and trail cameras',
      p: ['A trip plan sends your destination and back-by time to a contact as an ordinary text from your phone. A trail camera log sorts your photos with the likely animals first and charts visits against legal shooting light. Both stay on your phone.'] },
    { h2: 'Where the rules come from',
      p: ['Seasons, hunt units, draw results and access come from Utah DWR’s own guidebooks, published results and map services. A job runs every day that watches those sources for changes, and a reissued guidebook is read by a person before the app changes. Guidebook text is shown in Utah DWR’s words.'] },
  ],
  faq: [
    { q: 'Is Ranger Hawk free?',
      a: 'Yes. The app and the rules in it are free, with no ads and no account. How Ranger Hawk may earn money later is written out on its own page.' },
    { q: 'Does it work without cell signal?',
      a: 'Yes, once it has been opened online. Seasons, access points and the hunt finder work offline, and the full Utah map works offline after you tap Save map on the Map screen.' },
    { q: 'Is Ranger Hawk a Utah DWR app?',
      a: 'No. It is an independent app, not part of or endorsed by the Utah Division of Wildlife Resources. It shows Utah DWR’s own words and links to the source so you can confirm them.' },
    { q: 'How do I install it on my phone?',
      a: 'On iPhone, open rangerhawk.com in Safari and choose Share, then Add to Home Screen. On Android, open it in Chrome and choose Install app from the menu.' },
  ],
};

const FISHING = {
  path: '/fishing/',
  title: 'Utah fishing rules by water, limits, closures | Ranger Hawk',
  description: 'The rules for each Utah water, the statewide limits that apply, and every emergency change in force today, in Utah DWR’s words, readable with no signal.',
  h1: 'Utah fishing rules, water by water',
  lead: 'Ranger Hawk is a free phone app for fishing in Utah. Type the name of a water and it shows that water’s own rules, the statewide limits that apply, and any emergency change in force today, all in Utah DWR’s words and readable with no signal.',
  sections: [
    { h2: 'Places near you',
      p: ['{fish_places} places to fish from Utah DWR’s own map layers, nearest first by road drive time from a Utah town you choose, each marked with what the app found for it today.'] },
    { h2: 'Every water with rules of its own',
      p: ['All {specific_waters} entries of the guidebook’s rules for specific waters, and the {community_waters} community fishing waters.'] },
    { h2: 'Statewide limits and rules',
      p: ['The daily limits table, {general_rules} of the general rules, and the general rules for spearfishing.'] },
    { h2: 'Closures and emergency changes',
      p: ['Every emergency change and statewide closure in force, with the days each one has left.'] },
    { h2: 'What opening a water shows',
      p: ['From the top down: anything wrong with the rules as a whole today, any closure or emergency change, the water’s own rules stretch by stretch, the statewide limits with the rows that apply marked, and the rules for groups of waters that may also cover it. Where the app cannot be sure which rule applies, it shows every candidate and says so.'] },
    { h2: 'Where the rules come from',
      p: ['Rules come from Utah DWR’s fishing guidebook and the emergency changes Utah DWR posts beside it; places come from Utah DWR’s map layers. A job runs every day that watches for a new emergency change or a reissued guidebook, and a person reads each one before the app changes. Signs at the water govern where a rule says “as posted”.'] },
  ],
  faq: [
    { q: 'Where are the fishing rules for a particular Utah water?',
      a: 'In Utah DWR’s fishing guidebook, under the rules for specific waters, together with the statewide limits and any emergency change. Ranger Hawk shows all three together for the water you pick.' },
    { q: 'Does it work without cell signal?',
      a: 'Yes, once it has been opened online. The rules for every water, the statewide table and the emergency changes it last downloaded are on the phone.' },
    { q: 'Is Ranger Hawk a Utah DWR app?',
      a: 'No. It is an independent app, not part of or endorsed by the Utah Division of Wildlife Resources. It shows Utah DWR’s own words and links to the source so you can confirm them.' },
    { q: 'Does it cover Flaming Gorge, Bear Lake and Lake Powell?',
      a: 'Only Utah’s rules for them. Those waters are shared with Wyoming, Idaho and Arizona, whose rules are not in the app.' },
  ],
};

// Structured data for the home page's WebApplication entry (build_pages.js).
const APP = { applicationCategory: 'SportsApplication', operatingSystem: 'Any (web browser; installable on iPhone and Android)' };

// The privacy and money pages carry the in-app screens' own text (site.js), so
// only their head tags are written here.
const PRIVACY = {
  path: '/privacy/',
  title: 'Privacy | Ranger Hawk',
  description: 'What Ranger Hawk keeps on your phone, what leaves it, and whether visits are counted.',
};

const MONEY = {
  path: '/how-ranger-hawk-makes-money/',
  title: 'How Ranger Hawk makes money | Ranger Hawk',
  description: 'How Ranger Hawk may earn money, how paid links are marked, and what always stays free: the rules.',
};

const NOT_FOUND = {
  title: 'Page not found | Ranger Hawk',
  h1: 'That page is not here',
  lead: 'The app is at the home page. Hunting and fishing are described on their own pages.',
};

// llms.txt (llmstxt.org): H1, a one-paragraph summary, then link lists.
const LLMS = {
  details: [
    'Ranger Hawk is an installable web app (a PWA) for Utah only. It runs on the phone, keeps what the user enters on the phone, and has no account.',
    'Rule text is Utah DWR’s, shown with its source. A job runs every day that watches Utah DWR’s guidebooks, published results, emergency changes and map services for changes; a new emergency change or a reissued guidebook is read by a person before the app changes. Where the app cannot be sure a rule applies, it says so rather than guessing.',
    'It does not book trips, take payments or sell tags. The calendar feed of every deadline is at ' + SITE + '/hunt.ics.',
  ],
};

module.exports = { SITE, NAME, APP, ONE_LINE, DISCLAIMER, SOURCES, HOME, HUNTING, FISHING, PRIVACY, MONEY, NOT_FOUND, LLMS };
