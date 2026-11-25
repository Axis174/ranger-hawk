# Dawn trigger

Asks GitHub for the daily refresh run at 4:10 a.m. Mountain, because GitHub's
own schedule starts it 3 to 11 hours late (the evidence is in the main README
under "When the refresh runs"). It is a Cloudflare Worker with one job: once a
day it presses the same "Run workflow" door a person can press on the Actions
page. It serves nothing, stores nothing and has no public address.

**Status on 2026-11-25: built, not switched on.** Nothing here runs until Pete
has done the one-time setup below. It is live when the repo variable
`DAWN_TRIGGER` reads `on` and the Actions page shows a run started by
`workflow_dispatch` each morning (see "Checking it").

## What is in this folder

| File | What it is |
|---|---|
| `worker.js` | The Worker. Woken at 10:10 and 11:10 UTC, it goes on only at the one that is 4 a.m. in Utah, then asks GitHub for a run of `refresh.yml` on `main`. Up to three tries, 15 seconds apart, when GitHub hiccups; a refused token is not retried. |
| `wrangler.toml` | Its Cloudflare settings: the name, the two wake-up hours, no public address. No secret. |
| `test_worker.js` | `node ops/dawn-trigger/test_worker.js`. Checks the Utah hour across both clock changes, one run a day for every day of 2026 and 2027, the request, the retries, and that a visit to the address starts nothing. Run by hand; not part of the refresh workflow. |

## One-time setup (Pete)

The token is the only secret. It is typed or pasted by Pete into Cloudflare and
nowhere else: not in chat, not in this repo, not in a note.

1. **Create the token at GitHub.** Signed in as the repo owner: *Settings →
   Developer settings → Personal access tokens → Fine-grained tokens → Generate
   new token*.
   - Name: `ranger-hawk dawn trigger`
   - Expiration: one year
   - Repository access: *Only select repositories* → `ranger-hawk`
   - Permissions → Repository → **Actions: Read and write**. Nothing else.

   With that one permission the token can start and cancel runs in this one
   repo. It cannot change code, settings or anything in another repo.
2. **Put the Worker at Cloudflare.** From this folder:

   ```bash
   npx wrangler deploy
   ```

   The first time, it opens the browser to sign in to Cloudflare. It creates
   the Worker `ranger-hawk-dawn-trigger` with its two wake-up hours.
3. **Store the token in the Worker.**

   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```

   Paste the token when the terminal asks. Cloudflare never shows it again.
4. **Switch on the check that watches the trigger.** In the repo: *Settings →
   Secrets and variables → Actions → Variables → New repository variable*,
   name `DAWN_TRIGGER`, value `on`. From then on GitHub's own late run opens a
   `refresh-red` issue on any day the trigger asked for no run.

The dashboard does the same as steps 2 and 3 without a terminal: *Workers &
Pages → Create → Worker*, paste `worker.js`, then under the Worker's settings
add a secret named `GITHUB_TOKEN` and a cron trigger `10 10,11 * * *`, and turn
the `workers.dev` address off.

Cost: nothing. Cloudflare's free plan allows 5 cron triggers per account and
this uses one; GitHub's standard runners are free for a public repo.

## Checking it

- The morning after setup, the Actions page shows a run of *Refresh hunt data*
  started by `workflow_dispatch` at about 4:10 a.m. Mountain (10:10 UTC in
  summer, 11:10 UTC in winter).
- Cloudflare's page for the Worker lists each wake-up under its logs: two a
  day, one that says it is not 4 a.m. in Utah and one that asked for the run.

## When it stops

The usual cause is the token reaching its year. GitHub emails the owner before
that, and with `DAWN_TRIGGER` on a `refresh-red` issue appears the first day
no run is asked for.
Make a new token as in step 1 and repeat step 3. Nothing else changes.

Cloudflare publishes no promise about how punctually a cron trigger fires. If
the 4:10 run is ever seen starting late, that is new evidence, not a known
behaviour: write down the times.
