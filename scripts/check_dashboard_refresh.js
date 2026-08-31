// Runs on the runner's preinstalled Node before setup-node/npm ci. No packages.
// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const { createGitHubClient, readRunHistory, decideRefresh, SchedulerError } = require('./dashboard_schedule_policy');

/** @param {NodeJS.ProcessEnv} env @param {typeof fetch} [fetchImpl] */
async function checkDashboardRefresh(env, fetchImpl = fetch) {
  const watchdog = env.DASHBOARD_WATCHDOG === 'true';
  const force = !watchdog && env.DASHBOARD_FORCE === 'true';
  if (force) return { refresh: true, reason: 'manual-force', stale: [] };
  const now = Date.now();
  try {
    if (!env.GITHUB_TOKEN) throw new SchedulerError('github-token-missing');
    const client = createGitHubClient({ token: env.GITHUB_TOKEN, fetchImpl });
    const history = await readRunHistory(client, {
      now, currentRunId: env.GITHUB_RUN_ID, branch: env.GITHUB_REF_NAME, insideConcurrency: true,
    });
    /** @param {string} name @returns {unknown} */
    const read = (name) => {
      try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', name), 'utf8')); }
      catch { return null; } // Missing/malformed data is due for repair, not "fresh".
    };
    return decideRefresh({ history, now, documents: {
      holder: read('holder_rankings.json'), volume: read('pool_volume.json'), snapshot: read('onchain_snapshot.json'),
    } });
  } catch (error) {
    if (watchdog) throw error; // Extra invocations fail closed on uncertain history.
    // Keep GitHub's original hourly/manual refresh available during a metadata
    // API outage. The existing concurrency group still prevents parallel scans.
    console.warn(`::warning::Refresh guard unavailable (${error instanceof SchedulerError ? error.code : 'preflight-error'}); using native schedule`);
    return { refresh: true, reason: 'native-schedule-fallback', stale: [] };
  }
}

if (require.main === module) {
  checkDashboardRefresh(process.env).then((decision) => {
    console.log(JSON.stringify(decision));
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `refresh=${decision.refresh}\nreason=${decision.reason}\n`);
  }).catch((error) => {
    console.error(`::error::Refresh guard failed (${error instanceof SchedulerError ? error.code : 'preflight-error'})`);
    process.exitCode = 1;
  });
}

module.exports = { checkDashboardRefresh };
