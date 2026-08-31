import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ATTEMPT_STEP, REQUIRED_VOLUME_POOLS, MIN_REFRESH_INTERVAL_MS, WATCHDOG_STALE_AFTER_MS,
  createGitHubClient, readRunHistory, decideRefresh, staleComponents,
} from '../scripts/dashboard_schedule_policy';
import { checkDashboardRefresh } from '../scripts/check_dashboard_refresh';
import { pingBackupRpc } from '../scripts/ping_backup_rpc';

const now = Date.parse('2026-08-31T12:00:00Z');
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
function documents(age = 10) {
  return {
    holder: { lastRefreshed: ago(age) },
    volume: {
      pools: Object.fromEntries(REQUIRED_VOLUME_POOLS.map((address) => [address, { lastUpdated: ago(age) }])),
      checkpoints: Object.fromEntries(REQUIRED_VOLUME_POOLS.map((address) => [address, { lastBlock: 123, lastTimestamp: (now - age * 60_000) / 1000 }])),
    },
    snapshot: Object.fromEntries(['pools', 'burnStats', 'vaultTvl'].map((section) => [section, { generatedAt: ago(age), data: { navUpdatedAt: ago(10_000) } }])),
  };
}
const history = (age = 90, succeeded = true) => ({ active: false, attempt: { startedAt: now - age * 60_000, completedAt: now - (age - 1) * 60_000, succeeded } });
function run(id: number, conclusion = 'success', status = 'completed', age = 89) {
  return { id, status, conclusion, updated_at: ago(age) };
}
function jobs({ skipped = false, legacy = false, age = 90 } = {}) {
  return { total_count: 1, jobs: [{ started_at: ago(age), completed_at: ago(age - 1), steps: [{
    name: legacy ? 'Install dependencies' : ATTEMPT_STEP,
    conclusion: skipped ? 'skipped' : 'success', started_at: skipped ? null : ago(age),
  }] }] };
}
function fakeClient(responses: unknown[]) {
  const paths: string[] = [];
  return {
    paths,
    client: createGitHubClient({ token: 'test-token', now: () => now, fetchImpl: async (url) => {
      paths.push(String(url));
      assert.ok(responses.length, 'unexpected API call');
      return Response.json(responses.shift());
    } }),
  };
}

test('freshness requires every source, not the newest Last Sync or weekly NAV', () => {
  const data = documents();
  assert.deepEqual(staleComponents(data, now, MIN_REFRESH_INTERVAL_MS), []);
  data.snapshot.burnStats.generatedAt = ago(120);
  assert.deepEqual(staleComponents(data, now, MIN_REFRESH_INTERVAL_MS), ['snapshot:burnStats']);
  assert.equal(decideRefresh({ history: history(), documents: data, now }).refresh, true);
});

test('missing, invalid and future fields are stale; missing individual pools cannot hide', () => {
  const data = documents();
  data.holder.lastRefreshed = 'not-a-date';
  data.snapshot.pools.generatedAt = ago(-10);
  delete data.volume.pools[REQUIRED_VOLUME_POOLS[0]];
  delete data.volume.checkpoints[REQUIRED_VOLUME_POOLS[1]];
  const stale = staleComponents(data, now, MIN_REFRESH_INTERVAL_MS);
  assert.equal(stale.length, 4);
  assert.ok(stale.includes('holder'));
  assert.ok(stale.includes(`volume:${REQUIRED_VOLUME_POOLS[0]}`));
});

test('failed partial progress retries only after its completion cooldown', () => {
  assert.equal(decideRefresh({ history: history(40, false), documents: documents(), now }).refresh, false);
  const decision = decideRefresh({ history: history(65, false), documents: documents(), now });
  assert.equal(decision.refresh, true);
  assert.equal(decision.reason, 'retry-failed-attempt');
});

test('late duplicate and queued follow-up skip after the successful refresh', () => {
  assert.equal(decideRefresh({ history: history(10), documents: documents(10), now }).refresh, false);
  assert.equal(decideRefresh({ history: history(60), documents: documents(59), now }).refresh, true);
  assert.equal(decideRefresh({ history: history(60), documents: documents(59), now, staleAfterMs: WATCHDOG_STALE_AFTER_MS }).refresh, false);
  assert.equal(decideRefresh({ history: history(75), documents: documents(74), now, staleAfterMs: WATCHDOG_STALE_AFTER_MS }).refresh, true);
});

test('active runs stop external dispatch; manual force is explicit', () => {
  const active = { active: true, attempt: null };
  assert.equal(decideRefresh({ history: active, documents: documents(1000), now, force: true }).refresh, false);
  assert.equal(decideRefresh({ history: history(5), documents: documents(5), now, force: true }).refresh, true);
});

test('history skips successful guard-only runs without postponing the attempt clock', async () => {
  const { client, paths } = fakeClient([{ workflow_runs: [run(3), run(2), run(1, 'failure')] }, jobs({ skipped: true }), jobs({ skipped: true }), jobs()]);
  assert.deepEqual(await readRunHistory(client, { now }), history(90, false));
  assert.equal(paths.length, 4);
});

test('history recognizes the legacy workflow and failed preflight attempts', async () => {
  const legacy = fakeClient([{ workflow_runs: [run(1)] }, jobs({ legacy: true })]);
  assert.deepEqual(await readRunHistory(legacy.client, { now }), history());
  const failed = fakeClient([{ workflow_runs: [run(2, 'failure')] }, jobs({ skipped: true })]);
  assert.deepEqual(await readRunHistory(failed.client, { now }), history(90, false));
});

test('external history stops on a pending run without reading jobs', async () => {
  const { client, paths } = fakeClient([{ workflow_runs: [run(2, '', 'pending'), run(1)] }]);
  assert.deepEqual(await readRunHistory(client, { now }), { active: true, attempt: null });
  assert.equal(paths.length, 1);
});

test('inside concurrency ignores this run and queued siblings, reads last actual attempt', async () => {
  const { client } = fakeClient([{ workflow_runs: [run(3, '', 'queued'), run(2, '', 'in_progress'), run(1)] }, jobs()]);
  assert.deepEqual(await readRunHistory(client, { now, currentRunId: '2', insideConcurrency: true }), history());
});

test('older-created run that executed last controls cooldown, not the API creation order', async () => {
  const { client, paths } = fakeClient([{ workflow_runs: [run(2), run(1, 'failure', 'completed', 9)] }, jobs({ age: 10 })]);
  const result = await readRunHistory(client, { now });
  assert.deepEqual(result, history(10, false));
  assert.ok(paths[1].includes('/runs/1/jobs'));
  assert.equal(decideRefresh({ history: result, documents: documents(1000), now }).reason, 'attempt-cooldown');
});

test('cancelled pending runs with zero jobs or null start do not trigger native fail-open', async () => {
  for (const cancelled of [{ total_count: 0, jobs: [] }, { total_count: 1, jobs: [{ started_at: null, steps: [] }] }]) {
    const { client } = fakeClient([{ workflow_runs: [run(2, 'cancelled', 'completed', 5), run(1)] }, cancelled, jobs()]);
    assert.deepEqual(await readRunHistory(client, { now }), history());
  }
});

test('unbounded/ambiguous history and invalid attempt times fail closed', async () => {
  const bounded = fakeClient([{ workflow_runs: Array.from({ length: 20 }, (_, i) => run(20 - i)) }, ...Array.from({ length: 6 }, () => jobs({ skipped: true }))]);
  await assert.rejects(readRunHistory(bounded.client, { now }), /github-history-budget/);
  const invalid = fakeClient([{ workflow_runs: [run(1)] }, jobs({ age: -10 })]);
  await assert.rejects(readRunHistory(invalid.client, { now }), /github-attempt-time-invalid/);
});

test('watchdog preflight fails closed; native schedule retains its existing outage fallback', async () => {
  await assert.rejects(checkDashboardRefresh({ DASHBOARD_WATCHDOG: 'true', DASHBOARD_FORCE: 'true' }), /github-token-missing/);
  assert.equal((await checkDashboardRefresh({})).reason, 'native-schedule-fallback');
  assert.equal((await checkDashboardRefresh({ DASHBOARD_FORCE: 'true' })).reason, 'manual-force');
});

test('daily keepalive is not multiplied by workflow_dispatch and failures still back off', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'ixs-scheduler-'));
  const statePath = join(folder, 'control.json');
  let calls = 0;
  try {
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(String(init?.body)).method, 'eth_blockNumber');
      throw new Error('provider unavailable');
    };
    assert.equal(await pingBackupRpc({ url: '', statePath, now, fetchImpl }), 'not-configured');
    assert.equal(await pingBackupRpc({ url: 'https://rpc.invalid', statePath, now, fetchImpl }), 'request-failed');
    assert.equal(await pingBackupRpc({ url: 'https://rpc.invalid', statePath, now: now + 3600_000, fetchImpl }), 'already-attempted');
    assert.equal(calls, 1);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).lastKeepaliveAttemptDay, '2026-08-31');
    await pingBackupRpc({ url: 'https://rpc.invalid', statePath, now: now + 86400_000, fetchImpl });
    assert.equal(calls, 2);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('workflow guard precedes dependencies/RPC and preserves live-tip non-cancelling concurrency', () => {
  const workflow = readFileSync('.github/workflows/update-dashboard-data.yml', 'utf8');
  assert.ok(workflow.indexOf('ref: ${{ github.ref_name }}') < workflow.indexOf('id: freshness'));
  assert.ok(workflow.indexOf('id: freshness') < workflow.indexOf('name: Setup Node.js'));
  assert.ok(workflow.includes(`name: ${ATTEMPT_STEP}`));
  assert.ok(workflow.includes('cancel-in-progress: false'));
  assert.ok(workflow.includes('data/scheduler_control.json'));
  assert.ok(!workflow.includes("github.event_name == 'workflow_dispatch' ||"));
  for (const name of ['Setup Node.js', 'Install dependencies', 'Run pool updater', 'Upload run artifacts']) {
    const step = workflow.split(`- name: ${name}\n`)[1]?.split('\n      - name:')[0];
    assert.ok(step?.includes('if: ${{'), `${name} must be conditional`);
  }
});

test('keepalive preserves RPC health reporting with bounded, sanitized responses', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'ixs-keepalive-response-'));
  try {
    for (const [index, [body, expected]] of [
      ['{"jsonrpc":"2.0","result":"0x1234"}', 'rpc-ok'],
      ['{"error":{"message":"do not expose provider secrets"}}', 'rpc-error'],
      ['{"result":null}', 'invalid-response'],
      ['x'.repeat(8193), 'invalid-response'],
    ].entries()) {
      const result = await pingBackupRpc({ url: 'https://rpc.invalid', statePath: join(folder, `${index}.json`), now, fetchImpl: async () => new Response(body) });
      assert.equal(result, expected);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
