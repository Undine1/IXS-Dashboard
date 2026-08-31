import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { runWatchdog } from '../workers/scheduler/src/index';
import { ATTEMPT_STEP, REPOSITORY, REQUIRED_VOLUME_POOLS, createGitHubClient } from '../scripts/dashboard_schedule_policy';

const now = Date.parse('2026-08-31T12:00:00Z');
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const env = { ENABLED: 'true', GITHUB_TOKEN: 'test-secret-never-log' };
const sha = 'a'.repeat(40);

function fakeGitHub({ age = 90, failed = false, active = false, oldActive = false, dispatchStatus = 200, dispatchThrows = false } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    assert.ok(url.startsWith(`https://api.github.com/repos/${REPOSITORY}/`));
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${env.GITHUB_TOKEN}`);
    if (url.includes('/dispatches')) {
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), { ref: 'main', inputs: { watchdog: true, force: false } });
      if (dispatchThrows) throw new Error('uncertain result with secret response');
      return new Response(null, {
        status: dispatchStatus,
        headers: dispatchStatus >= 300 && dispatchStatus < 400
          ? { Location: 'https://redirect.invalid/private-destination' } : undefined,
      });
    }
    if (new URL(url).searchParams.has('status')) return Response.json({ total_count: oldActive ? 1 : 0, workflow_runs: [] });
    if (url.includes('/runs?')) return Response.json({ workflow_runs: [{ id: 123, updated_at: ago(age - 1), status: active ? 'queued' : 'completed', conclusion: failed ? 'failure' : 'success' }] });
    if (url.includes('/jobs?')) return Response.json({ total_count: 1, jobs: [{
      started_at: ago(age), completed_at: ago(age - 1),
      steps: [{ name: ATTEMPT_STEP, started_at: ago(age), conclusion: 'success' }],
    }] });
    if (url.includes('/git/ref/')) return Response.json({ object: { sha } });
    assert.equal(new URL(url).searchParams.get('ref'), sha, 'all documents must use the same immutable SHA');
    assert.equal(new Headers(init?.headers).get('accept'), 'application/vnd.github.raw+json');
    if (url.includes('holder_rankings.json')) return Response.json({ lastRefreshed: ago(age - 1) });
    if (url.includes('pool_volume.json')) return Response.json({
      pools: Object.fromEntries(REQUIRED_VOLUME_POOLS.map((address) => [address, { lastUpdated: ago(age - 1) }])),
      checkpoints: Object.fromEntries(REQUIRED_VOLUME_POOLS.map((address) => [address, { lastBlock: 123, lastTimestamp: (now - (age - 1) * 60_000) / 1000 }])),
    });
    if (url.includes('onchain_snapshot.json')) return Response.json(Object.fromEntries(['pools', 'burnStats', 'vaultTvl'].map((section) => [section, { generatedAt: ago(age - 1) }])));
    assert.fail(`unexpected path ${url}`);
  };
  return { calls, fetchImpl, clock: () => now };
}

test('disabled watchdog and missing secret perform no requests', async () => {
  const github = fakeGitHub();
  assert.equal((await runWatchdog({ ...env, ENABLED: 'false' }, github)).reason, 'disabled');
  assert.equal((await runWatchdog({ ...env, GITHUB_TOKEN: '' }, github)).reason, 'github-token-missing');
  assert.equal(github.calls.length, 0);
});

test('healthy cooldown takes two metadata calls and no source downloads/RPC', async () => {
  const github = fakeGitHub({ age: 20 });
  assert.deepEqual(await runWatchdog(env, github), { action: 'skip', reason: 'attempt-cooldown', requests: 2 });
  assert.equal(github.calls.length, 2);
});

test('queued job takes one metadata call and blocks another dispatch', async () => {
  const github = fakeGitHub({ active: true });
  assert.equal((await runWatchdog(env, github)).reason, 'run-active');
  assert.equal(github.calls.length, 1);
});

test('normal hourly freshness leaves GitHub alone, regardless of Vercel deployment age', async () => {
  const github = fakeGitHub({ age: 60 });
  assert.equal((await runWatchdog(env, github)).reason, 'data-fresh');
  assert.equal(github.calls.length, 6);
  assert.ok(github.calls.every(({ url, init }) => !url.includes('vercel') && init?.method === 'GET'));
});

for (const status of [200, 204]) {
  test(`stale data dispatches existing workflow once (HTTP ${status})`, async () => {
    const github = fakeGitHub({ dispatchStatus: status });
    const result = await runWatchdog(env, github);
    assert.equal(result.action, 'dispatch');
    assert.equal(result.requests, 12);
    assert.equal(github.calls.filter(({ init }) => init?.method === 'POST').length, 1);
  });
}

test('ambiguous POST timeout is not retried and does not expose its raw error', async () => {
  const github = fakeGitHub({ dispatchThrows: true });
  const result = await runWatchdog(env, github);
  assert.deepEqual(result, { action: 'error', reason: 'github-request-failed', requests: 12 });
  assert.equal(github.calls.filter(({ init }) => init?.method === 'POST').length, 1);
});

for (const status of [301, 302, 303, 307, 308]) {
  for (const method of ['GET', 'POST'] as const) {
    test(`GitHub ${method} rejects HTTP ${status} without following, retrying or leaking credentials`, async () => {
      const path = `/repos/${REPOSITORY}/${method === 'POST' ? 'actions/workflows/update-dashboard-data.yml/dispatches' : 'test'}`;
      const location = 'https://redirect.invalid/private-destination';
      let calls = 0;
      let cancelled = false;
      const client = createGitHubClient({
        token: env.GITHUB_TOKEN,
        fetchImpl: async (input, init) => {
          calls++;
          assert.equal(String(input), `https://api.github.com${path}`);
          assert.equal(init?.method, method);
          assert.equal(init?.redirect, 'manual');
          assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${env.GITHUB_TOKEN}`);
          return new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode('private redirect response')); },
            cancel() { cancelled = true; },
          }), { status, headers: { Location: location } });
        },
      });

      await assert.rejects(
        client.request(path, method === 'POST' ? { body: { ref: 'main' } } : {}),
        { code: `github-http-${status}`, message: `github-http-${status}` },
      );
      assert.equal(calls, 1);
      assert.equal(client.requestCount(), 1);
      assert.equal(cancelled, true, 'discard the redirect body without reading it');
    });
  }
}

test('a redirected workflow dispatch is an error, not success or a second POST', async () => {
  const github = fakeGitHub({ dispatchStatus: 302 });
  const result = await runWatchdog(env, github);
  assert.deepEqual(result, { action: 'error', reason: 'github-http-302', requests: 12 });
  assert.equal(github.calls.filter(({ init }) => init?.method === 'POST').length, 1);
  assert.ok(github.calls.every(({ url }) => new URL(url).origin === 'https://api.github.com'));
});

test('GitHub 401/403/429/503 and malformed metadata never dispatch or retry', async () => {
  for (const status of [401, 403, 429, 503]) {
    let calls = 0;
    const result = await runWatchdog(env, { clock: () => now, fetchImpl: async () => { calls++; return new Response('private error details', { status }); } });
    assert.equal(result.reason, `github-http-${status}`);
    assert.equal(calls, 1);
  }
  const result = await runWatchdog(env, { clock: () => now, fetchImpl: async () => Response.json({ unexpected: true }) });
  assert.equal(result.reason, 'github-runs-invalid');
});

test('failed refresh stays retryable even before the 70-minute freshness threshold', async () => {
  const github = fakeGitHub({ age: 65, failed: true });
  assert.equal((await runWatchdog(env, github)).reason, 'retry-failed-attempt');
  const cooling = fakeGitHub({ age: 60, failed: true });
  assert.equal((await runWatchdog(env, cooling)).reason, 'attempt-cooldown');
});

test('active rerun outside recent history blocks dispatch', async () => {
  const github = fakeGitHub({ oldActive: true });
  assert.equal((await runWatchdog(env, github)).reason, 'run-active');
  assert.ok(github.calls.every(({ init }) => init?.method === 'GET'));
});

test('GitHub client limits response size, requests, duration and authenticated scope', async () => {
  const path = `/repos/${REPOSITORY}/test`;
  const huge = createGitHubClient({ token: '', fetchImpl: async () => new Response('a'.repeat(512 * 1024 + 1)) });
  await assert.rejects(huge.request(path), /github-response-too-large/);
  const bounded = createGitHubClient({ token: '', fetchImpl: async () => Response.json({}) });
  await assert.rejects(bounded.request('/repos/another/project/test'), /github-path-invalid/);
  await assert.rejects(bounded.request(`${path}/../secret`), /github-path-invalid/);
  for (let i = 0; i < 18; i++) await bounded.request(path);
  await assert.rejects(bounded.request(path), /github-request-budget/);
  let clock = now;
  const expired = createGitHubClient({ token: '', now: () => clock });
  clock += 45_001;
  await assert.rejects(expired.request(path), /github-request-budget/);
});

test('HTTP handler never exposes a public dispatch endpoint', async () => {
  assert.equal((await worker.fetch()).status, 404);
});
