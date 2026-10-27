# Ranger Hawk: standing rules
Written 2026-10-26 from RANGER_HAWK_START_PROMPT.md; universal rules in ~/.codex/AGENTS.md apply. Not Axis, not HRI: no front door, no HRI signature.

## What it is
Ranger Hawk (rangerhawk.com, formerly Utah Hunt Atlas) is Pete's personal, installable phone app plus a daily data refresh for Utah hunting (birds, deer and elk) and fishing, with a calendar feed at hunt.ics. It is a personal project, not affiliated with UDWR, and everything it shows is labelled not legal advice.

## Stack and where things run
- Repo: ~/Documents/Hunt-2026/ranger-hawk, GitHub Axis174/ranger-hawk (public). Pages serves docs/ at rangerhawk.com.
- Vanilla JS, no build step. Bump VERSION in docs/sw.js on every app change and add new files to its SHELL list.
- Data builders live in scraper/ (Python standard library only; Node for page builds and tests). backend/ is scaffolded, not deployed (README).
- The calendar's event ids still end in @utah-hunt-atlas on purpose. Never change them.
- The manual is README.md; the long view is ~/Documents/Hunt-2026/RANGER_HAWK_DIRECTION.md.

## Data-refresh and deploy rails
- Daily refresh: .github/workflows/refresh.yml (scraper/refresh.py, contacts, calendar, static pages, tests, commit, Pages deploy). Local: `python3 scraper/refresh.py && python3 scraper/build_calendar.py`.
- Fishing: after any amendment or guidebook change run `python3 scraper/build_fishing.py` then `node scraper/fishing/test_fishing.js`; rebuild the places when the build says so.
- seasons.json is the one hunting file edited by hand. A guidebook reissue is read by a human; season tables are never parsed by guesswork.
- Regulatory data never ships without an independent check by checker (Opus) against the page images or the agency's own data. After a fix, re-check what the fix touched.
- Check state before trusting any save point: git status, git log --oneline -5, the live version (grep ranger-hawk-v docs/sw.js against rangerhawk.com), and `node scraper/fishing/test_fishing.js`.
- Verify on the live site after the Actions run.

## Content rules
- The app shows the agency's words verbatim. It never works out a merged limit or season. Anything it is unsure of carries a warning, never "statewide rules apply".
- No photos, street addresses, personal phone numbers or landowner names in the repo or on the site. Where an agency says to call, show its requirement in its words and point to its own page for the number.
- Secrets (API keys, tokens, passwords) never go in chat, the repo, a save point or a prompt. They go in the macOS Keychain or GitHub Actions secrets, and Pete puts them there himself.

## Money
- Every build task carries a money line: which revenue line it serves (outfitter directory, paid links, hunter convenience, giveaway audience, or none), what it lets us measure, the one monetization question hands researches alongside it, and what must be true before it is switched on in public. Findings go to ~/Documents/Hunt-2026/research/; the running tally lives in the save point.
- Never sell entries or a membership that carries entries. A paid link is labelled as paid beside the link and pitches the product, never a drawing.

## What Pete alone decides
- Any destructive, publishing or paid action (push, deploy, publish, spend): his separate yes right before it happens.
- Whether any paid link goes live.
- When the lawyer question comes back: decided together, right before Ranger Hawk first takes money or runs a public giveaway. Nothing waits on a lawyer until then.
- Where secrets are stored (he stores them).
- Anything a hunter or angler would rely on to stay legal, the wording on the site, and what is built in what order are judgment calls: bring options and a recommendation, do not assume.

## Where things go
- Everything Ranger Hawk stays in ~/Documents/Hunt-2026 (Pete's decision, 2026-10-05). Nothing is written to an HRI or Axis folder, SharePoint or OneDrive. HRI files may be read as a pattern when Pete asks and are never changed.
- Save points: ~/Documents/Hunt-2026/session-handoffs/, numbered *ranger-hawk*_SAVE_POINT_NN.md, line 2 starting BRIEF:, a row at the top of that folder's _INDEX.md, the model plan for what is left, and a Fable / hands / checker / Codex table.
- Codex packets: ~/Documents/Hunt-2026/codex-packets/. Codex gets the repo only, as a fresh git clone outside Documents (for example ~/RangerHawk-Codex), never pushes, and its branch comes back by git fetch. Delete the clone once merged.
- Links to files in replies are full paths in a final "Files:" block.

## Chris and the model floor
- Chris works on this project. The model floor is Opus 5.5 or Sonnet 5.5 at minimum; nothing below that touches it.
- Every task that produces something ends with a HANDOFF_FOR_CHRIS_<topic>_<date>.md.
