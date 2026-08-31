# Dashboard scheduling reliability

## Plan and rollout

1. Add the Actions freshness/cooldown guard before Node setup, dependency installation, or RPC. Keep the existing live-tip checkout and non-cancelling concurrency group.
2. Make the backup-provider keepalive independent of the trigger: one attempted ping per UTC day, recorded separately from all accounting state.
3. Add an independent Cloudflare Cron Worker that checks GitHub metadata every ten minutes and dispatches the existing workflow only when due.
4. Run regression tests, ESLint, both runtime typechecks, a Next production build, and an offline Worker-runtime transport check in addition to bundling. Push the verified revision and verify Vercel's Git deployment. Enable the Worker only with dashboard-scoped credentials.

The Worker ships **disabled** (`ENABLED="false"`). Committing it does not activate Cloudflare. The Actions guard is active as soon as the workflow reaches `main`.

## Load and policy

- Cloudflare runs at UTC minutes 7, 17, 27, 37, 47 and 57: **144 small checks/day**. It has no blockchain credentials, public HTTP trigger, database, KV, or Durable Object.
- A normal recent-success check makes **two GitHub GETs** (recent runs and the actual job's steps), then stops. An active recent run takes one GET. Source files are downloaded only outside the short cooldown.
- A typical dispatch decision takes **12 GitHub requests**, including exactly one POST. The hard per-invocation budget is 18 requests, 45 seconds total, 8 seconds per request, and 512 KiB per response. This is metadata/network work, not blockchain CU usage. Failed HTTP calls are not retried inside an invocation.
- Native cron remains hourly at :23. Its guard considers all source timestamps, with a 55-minute minimum between successful attempts to allow ordinary hourly jitter. The watchdog waits until a required source is at least 70 minutes old. Healthy data therefore normally stays within roughly 70–80 minutes **plus GitHub queue, updater, and deployment time** when the native schedule misses a slot; this is a target, not an SLA.
- Failed attempts wait **60 minutes after completion** before another automatic attempt. A recent partial checkpoint does not erase a known failure. Manual `force=true` is an explicit operator override; it is ignored when `watchdog=true`.
- Guard-only successes do not move the attempt clock. A late cron or two racing watchdog dispatches acquire the same existing lock and check the newly committed data before doing work. Skips do not install dependencies, call RPC, upload artifacts, commit, or trigger another Vercel build.
- Making missed hourly refreshes actually happen can increase total daily updater work relative to today's missed schedules. It does not add a second scan per refresh; incremental checkpoints and existing RPC budgets remain unchanged.

## Freshness and accuracy

The watcher reads `holder_rankings.json`, `pool_volume.json`, and `onchain_snapshot.json` from **one immutable `main` SHA**. It checks holder `lastRefreshed`, every required pool's own timestamp and embedded checkpoint, and `generatedAt` for pools, burn stats, and vault TVL. Missing/invalid/future dates are not treated as fresh. `navUpdatedAt` is deliberately excluded: a weekly NAV update is different from fetching the current vault state.

The UI's **Last snapshot sync** is the newest timestamp in the published snapshots, not an all-products health signal or the time a visitor loaded the page. The pools, burn and vault routes can fall back to live reads when a snapshot exceeds its configured maximum age (six hours by default); those reads do not advance the saved snapshot timestamp. Nor is an old Vercel deployment evidence that blockchain data needs refreshing. This scheduler does not poll the deployed UI, and cannot create an RPC loop merely because a Vercel build is delayed.

Pool timestamps can describe committed **partial progress**, not proof that an entire backlog is complete. Consequently, job outcomes and the `Begin dashboard refresh attempt` step are also checked. Balance/volume arithmetic, checkpoint semantics, and the holder state ref are untouched.

The Chainstack keepalive writes only `data/scheduler_control.json` (`lastKeepaliveAttemptDay`), included in the same ordinary data commit. Failure is nonfatal and counts as today's attempted ping. If that control file cannot be saved/pushed, a subsequent run may repeat one cheap ping. No accounting state is used as the keepalive marker.

## Credential setup and activation

Do not copy RPC keys, the broad `GH_PAT`, or credentials from another repository into this Worker. No dependencies or global tools need to be installed/updated for this change; it was tested with the existing Wrangler 4.109.0.

1. Select/authorize the Cloudflare account for **this dashboard**. Use a dedicated repository-scoped deployment credential/session. For CLI deployment, explicitly provide the chosen account's `CLOUDFLARE_ACCOUNT_ID` and authorized `CLOUDFLARE_API_TOKEN`; do not silently reuse another project's Wrangler login. No paid plan or billing change is required by the design; verify the selected account's limits before activation.
2. Create an expiring GitHub fine-grained token scoped to **Undine1/IXS-Dashboard only**: Actions read/write for job metadata and dispatch; Contents read-only for pinned snapshot/ref reads. No Contents write permission. Put it in a Cloudflare encrypted secret named `GITHUB_TOKEN`, not in Git, a command argument, or chat.
3. From `workers/scheduler`, deploy the disabled configuration, provision the secret through the interactive prompt, then explicitly enable:

   ```sh
   wrangler deploy --config wrangler.jsonc
   wrangler secret put GITHUB_TOKEN --config wrangler.jsonc
   wrangler deploy --config wrangler.jsonc --var ENABLED:true
   ```

   Account/deployment credentials must already be set securely for the commands above. The committed default stays disabled: a future ordinary deployment without the enable override safely disables dispatch again. Do not assume pushing this repository redeploys the Worker; its deployment is separate from Vercel.

   For dashboard-managed deployment, saving variables or secrets can create a version without activating it. Under **Deployments**, promote the version containing `ENABLED=true` and the encrypted `GITHUB_TOKEN` to 100%; verify the active version's bindings, not only the latest saved settings.

4. In Cloudflare's Cron/Workers Logs view, confirm `dashboard-watchdog` events. On a fresh repository, expect `skip` with `attempt-cooldown` or `data-fresh`. After a missed hourly slot, expect one `dispatch`, then the existing GitHub updater to succeed. Confirm the following delayed native run skips setup/install/updaters if it is too soon.
5. Verify the new data commit is deployed by Vercel and the served snapshot matches. An external scheduler improves trigger reliability, not GitHub runner or Vercel availability.

Disable immediately, without changing GitHub's native schedule:

```sh
wrangler deploy --config wrangler.jsonc --var ENABLED:false
```

Cloudflare says [Cron configuration changes may take up to 15 minutes to propagate](https://developers.cloudflare.com/workers/configuration/cron-triggers/). For permissions and current dispatch receipts, see [GitHub's workflow-dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

## Checks and operational limits

Run from the repository root using existing tools:

```sh
npm test
npm run lint
npm run typecheck:scheduler
npx --no-install tsc --noEmit
npm run build
wrangler types workers/scheduler/worker-configuration.d.ts --config workers/scheduler/wrangler.jsonc --strict-vars false --check
wrangler deploy --dry-run --config workers/scheduler/wrangler.jsonc --outdir workers/scheduler/dist
```

`worker-configuration.d.ts` is generated with the installed Wrangler; do not edit it. The Worker has a separate TypeScript environment so its runtime types cannot leak into Next.js.

The GitHub transport must use `redirect: 'manual'` and reject non-2xx responses, including every redirect, without following `Location` or retrying a dispatch. Do not replace this with `redirect: 'error'`: [workerd rejects that mode before making a request](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/http.c%2B%2B#L445), even though Node accepts it. A build, typecheck or injected fetch mock does not validate the Worker runtime's request options. Before deploying transport changes, also test the shared client and bundled Worker with native workerd `fetch`, fake credentials and mocked outbound services (no live GitHub dispatch/RPC); check both successful requests and refused redirects. Use an already-installed approved runtime, and report its version/compatibility-date limits instead of silently installing tools.

Metadata outages/rate limits cause the **external** watchdog to log an error and make no dispatch. A watchdog-triggered Actions preflight also fails closed. Native scheduled/manual runs deliberately retain their prior refresh behavior if the new metadata guard is unavailable, avoiding a new dependency that could suppress the original refresh path. This degraded fallback can do an extra sequential refresh; it cannot bypass the existing concurrency lock.

Recent attempt history is bounded to 20 created runs and at most six job inspections. Jobs are ordered by actual completion rather than creation. Before dispatch, separate active-status queries also catch an old run being re-run outside that history window. A **completed manual rerun outside the window**, particularly one unable to push its data, may not be represented in the cooldown history. Prefer the current workflow's manual dispatch instead of re-running ancient executions. This limitation does not alter accounting or permit concurrent scans.

An ambiguous dispatch timeout is never immediately retried: GitHub may already have accepted it. The next tick checks again; the in-job guard handles duplicate queued invocations. Workflow failures remain visible through the existing Actions status/alerts; the Worker adds structured error logs, **not a new email/Discord/Telegram notification channel**. Token expiry or two-hour staleness should be investigated in those views. No automatic human notification has been configured.

Regression coverage includes partial failures, delayed cron races, skipped attempts, cancelled pre-run jobs, out-of-order executions, old active reruns, invalid dates, one-SHA reads, response/request limits, rejected/ambiguous dispatches, no public dispatch route, and daily keepalive deduplication.
