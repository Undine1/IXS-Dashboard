// Shared by the dependency-free Actions preflight and the Cloudflare watchdog.
// Deliberately contains no filesystem, blockchain, or accounting operations.
// @ts-check

const REPOSITORY = 'Undine1/IXS-Dashboard';
const BRANCH = 'main';
const WORKFLOW = 'update-dashboard-data.yml';
const ATTEMPT_STEP = 'Begin dashboard refresh attempt';
const MIN_REFRESH_INTERVAL_MS = 55 * 60_000;
const FAILED_ATTEMPT_COOLDOWN_MS = 60 * 60_000;
const WATCHDOG_STALE_AFTER_MS = 70 * 60_000;
const REQUIRED_VOLUME_POOLS = [
  '0xd093a031df30f186976a1e2936b16d95ca7919d6',
  '0xd22a820dc52f1cacea7a5c86da16757f434f43c6',
];
const SNAPSHOT_FILES = ['holder_rankings.json', 'pool_volume.json', 'onchain_snapshot.json'];

class SchedulerError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value) : {};
}

/** @param {unknown} value @param {number} now */
function timestamp(value, now) {
  const ms = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 && ms <= now + 5 * 60_000 ? ms : null;
}

/** @typedef {{ startedAt: number, completedAt: number, succeeded: boolean }} Attempt */
/** @typedef {{ active: boolean, attempt: Attempt | null }} History */
/** @typedef {{ holder: unknown, volume: unknown, snapshot: unknown }} Documents */

/** Inspect every required product, not the UI's maximum Last Sync timestamp.
 * @param {Documents} documents @param {number} now @param {number} staleAfterMs
 */
function staleComponents(documents, now, staleAfterMs) {
  const volume = record(documents.volume);
  const pools = record(volume.pools);
  const checkpoints = record(volume.checkpoints);
  const snapshot = record(documents.snapshot);
  /** @type {Array<[string, unknown]>} */
  const fields = [['holder', record(documents.holder).lastRefreshed]];
  for (const address of new Set([...REQUIRED_VOLUME_POOLS, ...Object.keys(pools)])) {
    fields.push([`volume:${address}`, record(pools[address]).lastUpdated]);
    const checkpoint = record(checkpoints[address]);
    const seconds = checkpoint.lastTimestamp;
    const block = checkpoint.lastBlock;
    const valid = typeof seconds === 'number' && seconds > 0 && seconds * 1000 <= now + 5 * 60_000
      && typeof block === 'number' && Number.isSafeInteger(block) && block >= 0;
    fields.push([`checkpoint:${address}`, valid ? new Date(seconds * 1000).toISOString() : null]);
  }
  for (const section of ['pools', 'burnStats', 'vaultTvl']) {
    fields.push([`snapshot:${section}`, record(snapshot[section]).generatedAt]);
  }
  // navUpdatedAt belongs to the vault's weekly NAV, not this refresh schedule.
  return fields.filter(([, value]) => {
    const ms = timestamp(value, now);
    return ms === null || now - ms >= staleAfterMs;
  }).map(([name]) => name);
}

/** @param {History} history @param {number} now */
function cooldownReason(history, now) {
  if (history.active) return 'run-active';
  const attempt = history.attempt;
  if (!attempt) return null;
  const since = attempt.succeeded ? attempt.startedAt : attempt.completedAt;
  const interval = attempt.succeeded ? MIN_REFRESH_INTERVAL_MS : FAILED_ATTEMPT_COOLDOWN_MS;
  return now - since < interval ? 'attempt-cooldown' : null;
}

/** @param {{ history: History, documents: Documents, now: number, staleAfterMs?: number, force?: boolean }} options */
function decideRefresh({ history, documents, now, staleAfterMs = MIN_REFRESH_INTERVAL_MS, force = false }) {
  if (force && !history.active) return { refresh: true, reason: 'manual-force', stale: [] };
  const cooldown = cooldownReason(history, now);
  if (cooldown) return { refresh: false, reason: cooldown, stale: [] };
  const stale = staleComponents(documents, now, staleAfterMs);
  // A failed scan can persist recent *partial* progress. Fresh timestamps alone
  // must never turn that failed attempt into a healthy/skippable refresh.
  const failed = history.attempt !== null && !history.attempt.succeeded;
  return { refresh: failed || stale.length > 0, reason: failed ? 'retry-failed-attempt' : stale.length ? 'stale-data' : 'data-fresh', stale };
}

/** Bounded, repository-scoped GitHub client. Never follow a credentialed redirect.
 * @param {{ token: string, fetchImpl?: typeof fetch, now?: () => number }} options
 */
function createGitHubClient({ token, fetchImpl = fetch, now = Date.now }) {
  const deadline = now() + 45_000;
  let requests = 0;
  /** @param {string} path @param {{ body?: unknown, raw?: boolean }} [options] @returns {Promise<unknown>} */
  async function request(path, { body, raw = false } = {}) {
    if (!path.startsWith(`/repos/${REPOSITORY}/`) || path.includes('..') || path.includes('\\')) {
      throw new SchedulerError('github-path-invalid');
    }
    if (++requests > 18 || now() >= deadline) throw new SchedulerError('github-request-budget');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(8000, deadline - now()));
    try {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'ixs-dashboard-scheduler',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new SchedulerError(`github-http-${response.status}`);
      }
      if (body !== undefined) {
        // Current API returns 200; older versions returned 204. The receipt is
        // optional: a lost/invalid receipt must not cause a second POST.
        await response.body?.cancel();
        if (response.status !== 200 && response.status !== 204) throw new SchedulerError('github-dispatch-status');
        return null;
      }
      if (!response.body) throw new SchedulerError('github-empty-response');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 512 * 1024) throw new SchedulerError('github-response-too-large');
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return JSON.parse(text);
      } finally {
        await reader.cancel();
      }
    } catch (error) {
      // Never log a token, URL supplied by an API, or a raw response/error body.
      if (error instanceof SchedulerError) throw error;
      throw new SchedulerError('github-request-failed');
    } finally {
      clearTimeout(timeout);
    }
  }
  return { request, requestCount: () => requests };
}

/** @typedef {ReturnType<typeof createGitHubClient>} GitHubClient */

/** Successful no-op runs do not move the actual-attempt clock. Work is recognized
 * by a named step, with a legacy fallback for the pre-guard workflow. A failure
 * before that step still backs off, preventing repeated broken-run dispatches.
 * @param {GitHubClient} client
 * @param {{ now: number, currentRunId?: string, insideConcurrency?: boolean, branch?: string }} options
 * @returns {Promise<History>}
 */
async function readRunHistory(client, { now, currentRunId = '', insideConcurrency = false, branch = BRANCH }) {
  const data = record(await client.request(`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/runs?branch=${encodeURIComponent(branch)}&per_page=20`));
  if (!Array.isArray(data.workflow_runs)) throw new SchedulerError('github-runs-invalid');
  const runs = data.workflow_runs.map(record).filter((run) => String(run.id) !== currentRunId);
  for (const run of runs) {
    if (typeof run.id !== 'number' || !Number.isSafeInteger(run.id) || typeof run.status !== 'string') {
      throw new SchedulerError('github-run-invalid');
    }
  }
  // Inside the non-cancelling concurrency group, pending siblings cannot do
  // work until this run finishes. They must not make the current run skip.
  if (!insideConcurrency && runs.some((run) => run.status !== 'completed')) return { active: true, attempt: null };
  const completed = runs.filter((run) => run.status === 'completed').map((run) => {
    const updatedAt = timestamp(run.updated_at, now);
    if (updatedAt === null) throw new SchedulerError('github-run-time-invalid');
    return { run, updatedAt };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
  let inspected = 0;
  /** @type {Attempt | null} */
  let latest = null;
  for (const { run, updatedAt } of completed) {
    // Listing order is creation order, not execution order: an old queued run
    // or rerun can finish last. updated_at bounds job completion; inspect any
    // candidate that could be newer than the actual attempt already found.
    if (latest && updatedAt <= latest.completedAt) return { active: false, attempt: latest };
    if (++inspected > 6) throw new SchedulerError('github-history-budget');
    const jobsData = record(await client.request(`/repos/${REPOSITORY}/actions/runs/${run.id}/jobs?filter=latest&per_page=20`));
    if (!Array.isArray(jobsData.jobs) || jobsData.total_count !== jobsData.jobs.length) {
      throw new SchedulerError('github-jobs-invalid');
    }
    const neverStartedConclusion = run.conclusion === 'cancelled' || run.conclusion === 'skipped';
    // Replacing a pending concurrency run can cancel it before any job exists.
    if (jobsData.jobs.length === 0 && neverStartedConclusion) continue;
    if (jobsData.jobs.length !== 1) throw new SchedulerError('github-jobs-invalid');
    const job = record(jobsData.jobs[0]);
    if (job.started_at === null && neverStartedConclusion) continue;
    if (!Array.isArray(job.steps)) throw new SchedulerError('github-steps-invalid');
    const steps = job.steps.map(record);
    const marker = steps.find((step) => step.name === ATTEMPT_STEP);
    const legacy = marker ? undefined : steps.find((step) => step.name === 'Install dependencies');
    const step = marker || legacy;
    if (!step && run.conclusion === 'success') throw new SchedulerError('github-attempt-step-missing');
    const attempted = step && step.conclusion !== 'skipped' && step.started_at !== null;
    if (!attempted && run.conclusion === 'success') continue;
    if (typeof run.conclusion !== 'string') throw new SchedulerError('github-conclusion-invalid');
    const startedAt = timestamp(attempted ? step.started_at : job.started_at, now);
    const completedAt = timestamp(job.completed_at, now);
    if (startedAt === null || completedAt === null || completedAt < startedAt) throw new SchedulerError('github-attempt-time-invalid');
    if (!latest || completedAt > latest.completedAt) latest = { startedAt, completedAt, succeeded: run.conclusion === 'success' };
  }
  if (latest) return { active: false, attempt: latest };
  // A full page without an actual attempt is ambiguous; do not silently infer
  // that it is safe to run. The native cron has an explicit degraded fallback.
  if (data.workflow_runs.length === 20) throw new SchedulerError('github-history-incomplete');
  return { active: false, attempt: null };
}

/** Before a POST, also check active statuses independent of creation date. This
 * catches manual reruns of old runs outside the recent-history page. The common
 * healthy/cooldown path does not pay for these five small filtered requests.
 * @param {GitHubClient} client
 */
async function hasActiveRun(client) {
  for (const status of ['in_progress', 'queued', 'waiting', 'pending', 'requested']) {
    const data = record(await client.request(`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/runs?branch=${BRANCH}&status=${status}&per_page=1`));
    if (!Array.isArray(data.workflow_runs) || typeof data.total_count !== 'number') throw new SchedulerError('github-active-runs-invalid');
    if (data.total_count > 0 || data.workflow_runs.length > 0) return true;
  }
  return false;
}

/** Read the three files at one immutable branch SHA, never a mix of commits.
 * @param {GitHubClient} client @returns {Promise<Documents>}
 */
async function readGitHubDocuments(client) {
  const ref = record(await client.request(`/repos/${REPOSITORY}/git/ref/heads/${BRANCH}`));
  const sha = record(ref.object).sha;
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw new SchedulerError('github-ref-invalid');
  const [holder, volume, snapshot] = await Promise.all(SNAPSHOT_FILES.map((file) =>
    client.request(`/repos/${REPOSITORY}/contents/public/data/${file}?ref=${sha}`, { raw: true })));
  return { holder, volume, snapshot };
}

module.exports = {
  REPOSITORY, BRANCH, WORKFLOW, ATTEMPT_STEP, SNAPSHOT_FILES, REQUIRED_VOLUME_POOLS,
  MIN_REFRESH_INTERVAL_MS, FAILED_ATTEMPT_COOLDOWN_MS, WATCHDOG_STALE_AFTER_MS,
  SchedulerError, staleComponents, cooldownReason, decideRefresh,
  createGitHubClient, readRunHistory, readGitHubDocuments, hasActiveRun,
};
