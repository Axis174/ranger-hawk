// Run by hand: node ops/dawn-trigger/test_worker.js
// Not in the refresh workflow's test gate: the Worker runs at Cloudflare, not
// in the daily job, and nothing here touches the site.
import assert from 'node:assert/strict';
import worker, { utahHour } from './worker.js';

const at = (iso) => Date.parse(iso);
// The Worker's own log lines are not part of the test's output.
const say = console.log;
console.log = () => {};
let calls = [];
let answers = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  const a = answers.shift() || { status: 200, body: '{}' };
  if (a.throws) throw new Error(a.throws);
  // A 204 may not carry a body.
  return new Response(a.status === 204 ? null : (a.body || ''), { status: a.status });
};
// No real waiting between attempts in the test.
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => realTimeout(fn, 0);
const run = (iso, env = { GITHUB_TOKEN: 'test-token-not-real' }) =>
  worker.scheduled({ scheduledTime: at(iso) }, env);
const reset = (a = []) => { calls = []; answers = a; };

// Utah's hour, both sides of both clock changes of 2026 and 2027.
assert.equal(utahHour(at('2026-11-26T11:10:00Z')), 4);   // winter, MST
assert.equal(utahHour(at('2026-11-26T10:10:00Z')), 3);
assert.equal(utahHour(at('2026-07-15T10:10:00Z')), 4);   // summer, MDT
assert.equal(utahHour(at('2026-07-15T11:10:00Z')), 5);
assert.equal(utahHour(at('2026-10-31T10:10:00Z')), 4);   // last day of MDT
assert.equal(utahHour(at('2026-11-01T11:10:00Z')), 4);   // first day of MST
assert.equal(utahHour(at('2027-03-13T11:10:00Z')), 4);   // last day of MST
assert.equal(utahHour(at('2027-03-14T10:10:00Z')), 4);   // first day of MDT
assert.equal(utahHour(at('2026-11-26T07:10:00Z')), 0);   // midnight is 0, not 24

// Exactly one of the two daily wake-ups asks for a run, every day of two years.
for (let d = at('2026-01-01T00:00:00Z'); d < at('2028-01-01T00:00:00Z'); d += 86400000) {
  const day = new Date(d).toISOString().slice(0, 10);
  reset();
  await run(`${day}T10:10:00Z`);
  await run(`${day}T11:10:00Z`);
  assert.equal(calls.length, 1, `${day}: ${calls.length} runs asked for`);
}

// The request itself.
reset();
await run('2026-11-26T11:10:00Z');
assert.equal(calls[0].url, 'https://api.github.com/repos/Axis174/ranger-hawk/actions/workflows/refresh.yml/dispatches');
assert.equal(calls[0].init.method, 'POST');
assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token-not-real');
assert.deepEqual(JSON.parse(calls[0].init.body), { ref: 'main' });

// A GitHub hiccup is tried again; a wrong token is not.
reset([{ status: 502 }, { throws: 'network down' }, { status: 204 }]);
await run('2026-11-26T11:10:00Z');
assert.equal(calls.length, 3);
reset([{ status: 401, body: 'Bad credentials' }]);
await assert.rejects(run('2026-11-26T11:10:00Z'), /GitHub answered 401/);
assert.equal(calls.length, 1);
reset([{ status: 500 }, { status: 500 }, { status: 500 }]);
await assert.rejects(run('2026-11-26T11:10:00Z'), /GitHub answered 500/);
assert.equal(calls.length, 3);

// No secret, no call. And the token never appears in what is thrown.
reset();
await assert.rejects(run('2026-11-26T11:10:00Z', {}), /GITHUB_TOKEN secret is not set/);
assert.equal(calls.length, 0);
reset([{ status: 403, body: 'Resource not accessible' }]);
await run('2026-11-26T11:10:00Z').catch((e) => assert.ok(!String(e.message).includes('test-token-not-real')));

// A visit to the address starts nothing.
reset();
const res = await worker.fetch();
assert.equal(res.status, 404);
assert.equal(calls.length, 0);

say('dawn trigger: all checks pass');
