import {
  BRANCH, REPOSITORY, WORKFLOW, WATCHDOG_STALE_AFTER_MS, SchedulerError,
  createGitHubClient, readRunHistory, readGitHubDocuments, hasActiveRun, cooldownReason, decideRefresh,
} from '../../../scripts/dashboard_schedule_policy';

export async function runWatchdog(
  env: Pick<Env, 'ENABLED' | 'GITHUB_TOKEN'>,
  { fetchImpl = fetch, clock = Date.now }: { fetchImpl?: typeof fetch; clock?: () => number } = {},
) {
  if (env.ENABLED !== 'true') return { action: 'skip', reason: 'disabled', requests: 0 };
  if (!env.GITHUB_TOKEN?.trim()) return { action: 'error', reason: 'github-token-missing', requests: 0 };
  const client = createGitHubClient({ token: env.GITHUB_TOKEN, fetchImpl, now: clock });
  try {
    const now = clock();
    const history = await readRunHistory(client, { now });
    const cooldown = cooldownReason(history, now);
    if (cooldown) return { action: 'skip', reason: cooldown, requests: client.requestCount() };
    const documents = await readGitHubDocuments(client);
    const decision = decideRefresh({ history, documents, now, staleAfterMs: WATCHDOG_STALE_AFTER_MS });
    if (!decision.refresh) return { action: 'skip', reason: decision.reason, requests: client.requestCount() };
    if (await hasActiveRun(client)) return { action: 'skip', reason: 'run-active', requests: client.requestCount() };

    // Exactly one POST. A timeout can mean GitHub accepted the dispatch; do not
    // retry it here. The next cron checks history, and Actions rechecks freshness
    // under its lock even if two invocations raced or GitHub was slow to list it.
    await client.request(`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`, {
      body: { ref: BRANCH, inputs: { watchdog: true, force: false } },
    });
    return { action: 'dispatch', reason: decision.reason, stale: decision.stale, requests: client.requestCount() };
  } catch (error) {
    return { action: 'error', reason: error instanceof SchedulerError ? error.code : 'watchdog-failed', requests: client.requestCount() };
  }
}

export default {
  async scheduled(_controller, env) {
    // Await all work. Returning normally after a logged error avoids immediate
    // application retries; the next ten-minute tick performs a new safety check.
    const result = await runWatchdog(env);
    const entry = { event: 'dashboard-watchdog', ...result };
    if (result.action === 'error') console.error(entry);
    else console.log(entry);
  },
  // The production Worker has no public route, including no HTTP dispatch hook.
  async fetch() {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
