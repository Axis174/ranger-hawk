// Ranger Hawk dawn trigger.
//
// GitHub starts its own scheduled runs hours late (every one of the 66 from
// 2026-09-21 to 2026-11-25 began 2.9 to 11.4 hours after the set time), and its
// documentation promises no limit. A run that is ASKED for is not held up that
// way (a push has its run created a second or two later). So this Cloudflare
// Worker asks for one every morning: it calls the "Run workflow" door
// (workflow_dispatch) of .github/workflows/refresh.yml, the same thing the
// button on the Actions page does.
//
// It holds one secret, GITHUB_TOKEN, which Pete creates and stores himself
// (README.md beside this file). The token is never in this repo.
//
// Cloudflare's clock is UTC and Utah's is not, so the Worker is woken at 10:10
// and 11:10 UTC and goes on only when that moment is 4 a.m. in Utah: 4:10 a.m.
// Mountain in summer and in winter, one run a day.

const REPO = 'Axis174/ranger-hawk';
const WORKFLOW = 'refresh.yml';
const BRANCH = 'main';
const UTAH_HOUR = 4;
const ATTEMPTS = 3;
const WAIT_MS = 15000;

// The hour of the day in Utah (0 to 23) at a moment given in milliseconds.
export function utahHour(ms) {
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(ms));
  return Number(text);
}

async function askForRun(token) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'ranger-hawk-dawn-trigger',
      },
      body: JSON.stringify({ ref: BRANCH }),
    },
  );
  if (res.ok) return { ok: true };
  const said = (await res.text()).slice(0, 300);
  // 401, 403, 404, 422: the token or the address is wrong. Trying again will
  // not help, so stop at once and say so.
  return { ok: false, final: res.status < 500 && res.status !== 429, said: `GitHub answered ${res.status}: ${said}` };
}

export default {
  async scheduled(controller, env) {
    if (utahHour(controller.scheduledTime) !== UTAH_HOUR) {
      console.log('not 4 a.m. in Utah at this wake-up; nothing to do');
      return;
    }
    if (!env.GITHUB_TOKEN) throw new Error('the GITHUB_TOKEN secret is not set');
    let last = '';
    for (let i = 1; i <= ATTEMPTS; i++) {
      let r;
      try {
        r = await askForRun(env.GITHUB_TOKEN);
      } catch (e) {
        r = { ok: false, final: false, said: `could not reach GitHub: ${e && e.message}` };
      }
      if (r.ok) { console.log(`refresh run asked for on attempt ${i}`); return; }
      last = r.said;
      console.log(`attempt ${i} failed: ${last}`);
      if (r.final || i === ATTEMPTS) break;
      await new Promise((done) => setTimeout(done, WAIT_MS));
    }
    // Thrown so the failure shows in Cloudflare's own log for this Worker. The
    // refresh workflow also notices: its alarm job opens an issue on any day no
    // run was asked for (repo variable DAWN_TRIGGER).
    throw new Error(`dawn trigger failed: ${last}`);
  },

  // Nothing is served. A visit to the Worker's address starts nothing.
  async fetch() {
    return new Response('Not found', { status: 404 });
  },
};
