# IXS / Blockchain Dashboard

A production-ready analytics dashboard that tracks IXS token burns and Total Value Locked (TVL) across multiple chains (Ethereum, Polygon, Base). It uses lightweight on-chain reads (JSON-RPC / eth_call) and a small set of update scripts to maintain aggregated pool volumes and burn statistics written to `public/data`.

**Status:** Working prototype with multi-chain support, an indexer-backed incremental updater, and CI automation to persist computed artifacts.

## Quick links
- App entry: [app/page.tsx](app/page.tsx)
- APIs: [app/api/pools/route.ts](app/api/pools/route.ts), [app/api/burnStats/route.ts](app/api/burnStats/route.ts)
- Components: [components/BurnStats.tsx](components/BurnStats.tsx), [components/TransactionList.tsx](components/TransactionList.tsx)
- Scripts: `scripts/update_pool_volume_indexer.js`
- Data outputs: `public/data/pool_volume.json`, `public/data/pool_volume_checkpoint.json`, `public/data/pool_volume_runs.json`, `public/data/pool_volume_alert.json`
- CI workflow: `.github/workflows/update-pool-volume.yml`

## Project overview
- Purpose: Track cumulative token burns and pool TVL (USD) using on-chain derived prices where possible. Also maintain a seeded, incremental "life-time volume" metric for selected pools via log-scanning (USDC Transfer events) and indexer fallbacks.
- Approach: Use an indexer (Etherscan-compatible API) for incremental updates with retries and checkpoints. Scripts persist results to `public/data/` so the Next.js app can serve stable, cached artifacts.

## Tech stack
- Next.js (App Router) + TypeScript
- Tailwind CSS
- Node.js scripts for background tasks (under `scripts/`)
- Minimal direct JSON-RPC (no heavy web3 frameworks for indexer/RPC calls)

## Files & structure (high-level)
- `app/` — Next.js app routes and pages (`page.tsx`, `layout.tsx`, `globals.css`)
- `app/api/` — server routes: `pools/route.ts` (TVL), `burnStats/route.ts` (burn addresses)
- `components/` — UI components used by the dashboard
- `lib/` — on-chain helpers, token/burn services, TVL config loader and utils
- `scripts/` — updater scripts
  - `update_pool_volume_indexer.js` — indexer-based incremental updater (Etherscan v2 compatible), resilient (exponential backoff, deterministic per-pool jitter), writes `public/data/pool_volume*.json` and `public/data/pool_volume_alert.json` on failure
- `public/data/` — computed artifacts persisted by CI scripts (consumed by the front-end)
- `.github/workflows/` — CI workflows; `update-pool-volume.yml` runs the updater and commits outputs

## Environment variables
Create a `.env.local` in the project root (do not commit). Key variables used by the project and CI scripts:
- `ALCHEMY_API_KEY` — (optional) used by provider-based RPC endpoints if configured
- `ETHERSCAN_API_KEY` — default key for indexer-based updater (Etherscan-compatible indexer)
- `POLYGONSCAN_API_KEY` — (optional) Polygon-native explorer key for pool updater
- `BASESCAN_API_KEY` — (optional) Base-native explorer key for pool updater
- `BASESCAN_API_BASE_URL` — (recommended for Base) set to `https://base.blockscout.com/api` to use Blockscout's RPC-compatible API for `module/action` calls
- `BASE_RPC` / `BASE_RPC_LIST` — (optional) Base JSON-RPC endpoint(s) for fallback log scanning
- `POLYGON_RPC` / `POLYGON_RPC_LIST` — (optional) Polygon JSON-RPC endpoint(s) for fallback log scanning
- `GH_PAT` — (CI only) personal access token used by the workflow to push generated artifacts back to the repo
- `POLYGON_USDC` - optional override of the default tracked USDC token address for updater jobs

Note: scripts/update_pool_volume_indexer.js automatically reads .env.local for local runs when variables are not already exported in the shell.

## Running locally
1. Install deps
```bash
npm ci
```

2. Dev server
```bash
npm run dev
```

3. Run updater scripts locally (example):
```bash
cd scripts
node update_pool_volume_indexer.js  # primary updater (recommended)
```

Notes: The scripts write to `public/data/` — running them locally will overwrite those files and they will be served by the dev server.

## APIs
- `GET /api/pools` — returns pools with computed `value` fields (USD). If a pool's USD price cannot be derived from configured price-source pools the `value` will be `0`.
- `GET /api/burnStats` — returns aggregated burn totals and per-address balances.

## Updater behavior and resilience
- Indexer script uses exponential backoff with full jitter, honors `Retry-After`, and writes an alert file `public/data/pool_volume_alert.json` when retry budget is exhausted.
- If indexer access is plan-restricted for a chain, the updater automatically falls back to chain RPC (`eth_getLogs`) when RPC endpoints are available.
- The updater maintains per-pool checkpoints in `public/data/pool_volume_checkpoint.json` so runs can resume without re-scanning completed ranges.

## CI / GitHub Actions
- The repository contains `.github/workflows/update-pool-volume.yml` that runs the updater, commits `public/data/*` outputs, and deploys. The workflow uses a concurrency group to avoid overlapping runs and a PAT (`GH_PAT`) to push commits.
- Actions compatibility note: when authoring or pinning actions, prefer `@actions/core@^1.10.0` (or newer) for any authored/composed actions; avoid deprecated workflow commands such as `::set-output` / `::save-state` and update or pin third-party actions that still use them.

## Data outputs
- `public/data/pool_volume.json` — per-pool cumulative totals (seeded values + increments)
- `public/data/pool_volume_checkpoint.json` — per-pool scan checkpoints (last-scanned block/timestamp)
- `public/data/pool_volume_runs.json` — run history and counters
- `public/data/pool_volume_alert.json` — alert produced if updater exhausted retry budget

## Troubleshooting
- If updates fail, inspect `public/data/pool_volume_alert.json` and `public/data/pool_volume_runs.json` to identify failing pools or APIs.

## Contributing
- Keep `POOLS` configuration (in `app/api/pools/route.ts`) ordered: price-source pools (e.g., token‑USDC price sources) must be listed before pools that depend on those prices.
- When adding new pools, add a price-source pool for the chain if none exists.

## Next steps and optional improvements
- Add runtime validation that warns/fails when pools exist for a chain but no price-source pool is configured.
- Add telemetry for API/indexer usage and per-run provider counters.

If you'd like, I can also add a small CI check to scan `.github/workflows/` for deprecated workflow commands or implement the runtime price-source validation — tell me which to add next.


