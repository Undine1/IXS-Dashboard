# IXS / Blockchain Dashboard

A production-ready analytics dashboard that tracks IXS token burns, Total Value Locked (TVL), and holder rankings across Ethereum, Polygon, and Base. It uses lightweight on-chain reads plus a small set of updater scripts that persist artifacts into `public/data`.

**Status:** Working prototype with multi-chain support, Alchemy-first incremental updaters, and CI automation to persist computed artifacts.

## Quick links
- App entry: [app/page.tsx](app/page.tsx)
- APIs: [app/api/pools/route.ts](app/api/pools/route.ts), [app/api/burnStats/route.ts](app/api/burnStats/route.ts), [app/api/holderRankings/route.ts](app/api/holderRankings/route.ts)
- Components: [components/BurnStats.tsx](components/BurnStats.tsx)
- Scripts: `scripts/update_pool_volume_indexer.js`, `scripts/update_holder_rankings.js`
- Data outputs (committed): `public/data/pool_volume.json`, `public/data/holder_rankings.json`, `public/data/pool_volume_checkpoint.json`, `public/data/onchain_snapshot.json`
- Debug outputs (CI artifacts only, gitignored): `public/data/pool_volume_runs.json`, `public/data/pool_volume_alert.json`
- CI workflows: `.github/workflows/update-dashboard-data.yml`, `.github/workflows/codeql.yml`

## Project overview
- Purpose: Track cumulative token burns, pool TVL (USD), and IXS holder rankings using on-chain derived data where possible.
- Approach: Use Alchemy as the primary RPC provider, with Infura and optional per-chain Chainstack RPC URL fallbacks. Scripts persist outputs so the Next.js app can serve stable snapshots.

## Tech stack
- Next.js (App Router) + TypeScript
- Tailwind CSS
- Node.js scripts for background tasks
- Direct JSON-RPC calls where possible

## Files & structure
- `app/` - Next.js routes and pages
- `app/api/` - API routes for pools, burn stats, and holder rankings
- `components/` - UI components used by the dashboard
- `lib/` - on-chain helpers, token/burn services, TVL config loader, and utils
- `scripts/` - updater scripts
  - `update_pool_volume_indexer.js` - incremental pool volume updater
  - `update_holder_rankings.js` - incremental holder snapshot updater
- `public/data/` - public artifacts consumed by the app
- `data/` - non-public incremental state and manual label registry for holder rankings
- `.github/workflows/` - scheduled automation

## Environment variables
Create a `.env.local` in the project root.

- `ALCHEMY_API_KEY` - primary shared RPC credential for Ethereum, Polygon, and Base
- `BACKUP_INFURA_API_KEY` - optional Infura project key used as fallback
- `BACKUP_CHAINSTACK_BASE_RPC_URL` - optional full HTTPS Chainstack Base RPC URL used as a third fallback for Base and by the once-daily workflow keepalive ping
- `RPC_LIVE_READ_TOKEN` - optional server-only token required in the `x-ixs-live-rpc-token` header when using the operational `?fresh=1` or `?debug=1` live-RPC bypasses
- `MULTICALL3_ADDRESS` - optional override for the canonical Multicall3 deployment used to batch hourly snapshot reads
- `HOLDER_RANKINGS_ASSET_TRANSFERS_PAGE_SIZE` - optional page size for Alchemy transfer pagination
- `HOLDER_RANKINGS_EXCLUDED_ADDRESSES` - optional comma-separated addresses to hide from the public holder ranking
- `HOLDER_RANKINGS_LOG_CHUNK` - optional initial `eth_getLogs` block span
- `HOLDER_RANKINGS_MAX_FALLBACK_LOG_WINDOWS` - optional cross-chain cap for standard-RPC fallback windows per updater run (default `2000`)
- `API_RATE_LIMIT_MAX_ATTEMPTS` - optional maximum attempts for a single 429 response path (default `2`; other transient failures retain `API_MAX_ATTEMPTS`)
- `HOLDER_RANKINGS_MIN_LOG_CHUNK` - optional minimum block span after backoff
- `HOLDER_RANKINGS_SAVE_EVERY_BATCHES` - optional save cadence during long bootstrap runs
- `HOLDER_RANKINGS_RECONCILE_BATCH_SIZE` - optional number of flagged holder `balanceOf` reads per exact-checkpoint Multicall3 request (default `100`)
- `GH_PAT` - CI token used to push generated artifacts
- `POLYGON_USDC` - optional override of the tracked USDC token address for pool volume jobs
- `RPC_LOG_BLOCK_CHUNK_POLYGON` / `RPC_LOG_BLOCK_CHUNK_BASE` - optional initial pool-volume fallback spans (defaults `3000` / `5000`; provider errors still shrink adaptively)
- `RPC_MIN_LOG_BLOCK_CHUNK_POLYGON` / `RPC_MIN_LOG_BLOCK_CHUNK_BASE` - optional per-chain pool-volume fallback floors; `RPC_MIN_LOG_BLOCK_CHUNK` remains the shared fallback
- `RPC_ALCHEMY_TARGET_CUPS` - optional pool/holder updater pacing target (default `600`); method-weighted Alchemy pacing leaves throughput headroom while other providers retain a 100 ms per-provider gap
- `RPC_MIN_INTERVAL_MS` - optional legacy fixed pacing override for every pool/holder RPC provider; `0` disables pacing
- `NEXT_PUBLIC_TOTAL_SUPPLY` (or `TOTAL_SUPPLY`) - optional override of the 180M IXS max supply; read by both the dashboard and `/metrics` via `lib/supply.ts` so they cannot drift

`scripts/update_pool_volume_indexer.js` and `scripts/update_holder_rankings.js` both auto-load `.env.local` when environment variables are not already exported.

## Running locally
1. Install dependencies
```bash
npm ci
```

2. Start the dev server
```bash
npm run dev
```

3. Run the pool volume updater
```bash
node ./scripts/update_pool_volume_indexer.js
```

4. Run the holder rankings updater
```bash
npm run update:holder-rankings
```

The updaters write to `public/data/`. The holder updater also writes `data/holder_rankings_state.json`.

## APIs
- `GET /api/pools` - returns pools with computed USD values, served from the hourly `public/data/onchain_snapshot.json`; falls back to live RPC reads when the snapshot is missing or older than 6 hours, or with `?fresh=1`/`?debug=1`
- `GET /api/burnStats` - returns aggregated burn totals and per-address balances, same snapshot-first/live-fallback behavior as `/api/pools`
- `GET /api/holderRankings` - returns the latest file-backed holder snapshot from `public/data/holder_rankings.json`
- `GET /metrics` - public CORS-open aggregate (TVL, burned, supply) consumed by external sites; composed from the same snapshot-backed services, response shape is stable

## Updater behavior
- The pool volume updater uses Alchemy Asset Transfers first, falls back to JSON-RPC log scans through Infura and then optional Chainstack URLs when needed, and persists per-pool checkpoints.
- The holder rankings updater uses Alchemy Asset Transfers pagination when available, falls back to standard JSON-RPC if needed, keeps cumulative per-holder balances in `data/holder_rankings_state.json`, and writes a public top-500 snapshot. Any non-Transfer balance exceptions are kept in a durable retry queue and reconciled in Multicall3 batches at the exact saved scan block; individual exact-block reads retain the failure fallback.
- The public holder ranking excludes zero/dead/token-contract addresses by default and supports extra exclusions through env vars.
- The first holder rankings run is the expensive bootstrap. Later runs only scan blocks after the last saved checkpoint.

## GitHub Actions
- `.github/workflows/update-dashboard-data.yml` runs hourly (at minute 23 — off the congested top of the hour, where GitHub delays or drops scheduled runs). The daily 00:23 UTC schedule event sends a lightweight `eth_blockNumber` keepalive request to the Chainstack backup Base RPC when configured (manual runs also exercise it); the other hourly events skip that standalone call even if runner startup is delayed. Every run executes the pool volume updater, the holder rankings updater, and the on-chain snapshot (pool reserve valuations + burn balances), then commits the served data files back to `main` in a single push so Vercel builds the new data once per run. The holder rankings incremental state is persisted separately on the `refs/data-state` ref (single orphan commit, no history) rather than in `main`, so the repo doesn't accumulate a ~1 MB state version every hour.
- Because of the snapshot, Vercel makes no RPC calls in steady state — its RPC keys are only used by the live fallback paths.
- The deployment-baked holder-ranking and pool-volume API responses are prerendered and retained by Vercel's CDN for the lifetime of that immutable deployment; malformed baked snapshots fail the new build so the previous healthy deployment remains active. `/api/syncStatus` stays dynamic with a five-minute shared-cache TTL.
- Authorized live pool/burn fallbacks batch reads into one Multicall3 request per involved chain; any failed batch or subcall falls back to the existing individual provider path.
- The config-triggered pool metadata verifier uses two dependent Multicall3 phases per involved chain (pair token addresses, then those actual tokens' decimals), reducing its healthy path from 24 to 4 physical RPC calls while retaining individual fallback for failed or malformed results.
- The two updater steps are independent: a pool-updater failure does not block the holder rankings step (and vice versa), and the commit step pushes whatever valid progress was produced so the next run resumes from checkpoints. The job still reports failure when any step failed.
- Pool/holder RPC attempt counts, per-provider/method breakdowns, pacing waits, and conservative Alchemy CU estimates are uploaded in `data/rpc_usage.json`; the keepalive, on-chain snapshot, and Vercel live fallback are explicitly outside that artifact's scope.
- `.github/workflows/codeql.yml` runs CodeQL analysis on code changes and a weekly schedule; data-only commits are excluded via `paths-ignore`.
- Production deploys are expected to come from Vercel's Git integration on pushes to `main`, not from the workflows themselves. Vercel does not honor `[skip ci]`, which is what makes data-commit deploys work.

## Data outputs
- `public/data/pool_volume.json` - per-pool cumulative totals and authoritative scan checkpoints
- `public/data/pool_volume_checkpoint.json` - derived checkpoint compatibility/monitoring mirror
- `public/data/pool_volume_runs.json` - pool updater run history (gitignored; uploaded as a CI artifact per run, not committed)
- `public/data/pool_volume_alert.json` - pool updater alert output (gitignored; CI artifact only)
- `public/data/holder_rankings.json` - top-holder snapshot served by `/api/holderRankings`
- `public/data/onchain_snapshot.json` - hourly pool-valuation and burn-balance snapshot served by `/api/pools`, `/api/burnStats`, and `/metrics`
- `data/holder_rankings_state.json` - non-public cumulative balances and per-chain checkpoints for holder rankings (gitignored; persisted between runs on the `refs/data-state` ref as a single orphan commit, plus a per-run CI artifact backup — not committed to `main`)
- `data/holder_labels.json` - manual address labels and exclusion rules for holder rankings

## Troubleshooting
- If pool updates fail, inspect `public/data/pool_volume_alert.json` and `public/data/pool_volume_runs.json` — download them from the failing run's `dashboard-data-artifacts` artifact (they are no longer committed).
- If holder updates fail, run `npm run update:holder-rankings` locally with the same RPC credentials and inspect `data/holder_rankings_state.json`.

## Additional docs
- [docs/pool_volume_automation.md](docs/pool_volume_automation.md)
- [docs/holder_rankings_automation.md](docs/holder_rankings_automation.md)

## Repository notes
- **Git history was squashed to a single root commit on 2026-06-14.** The repo had
  accumulated thousands of hourly `data: update …` commits (each rewriting ~1 MB of
  JSON), so the past history was reset to keep clones small. This is expected — a
  shallow/short `git log` is normal. The rationale behind design decisions lives in
  this README, `docs/`, and code comments rather than in commit history.
- Hourly data updates continue to commit the served snapshots to `main`; the holder
  rankings incremental state is kept off `main` on the `refs/data-state` ref (a single
  orphan commit, no history) so per-hour state versions don't re-bloat the repo. See
  the GitHub Actions section above.
