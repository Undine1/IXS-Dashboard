# IXS / Blockchain Dashboard

A production-ready analytics dashboard that tracks IXS token burns, Total Value Locked (TVL), and holder rankings across Ethereum, Polygon, and Base. It uses lightweight on-chain reads plus a small set of updater scripts that persist artifacts into `public/data`.

**Status:** Working prototype with multi-chain support, Alchemy-first incremental updaters, and CI automation to persist computed artifacts.

## Quick links
- App entry: [app/page.tsx](app/page.tsx)
- APIs: [app/api/pools/route.ts](app/api/pools/route.ts), [app/api/burnStats/route.ts](app/api/burnStats/route.ts), [app/api/holderRankings/route.ts](app/api/holderRankings/route.ts)
- Components: [components/BurnStats.tsx](components/BurnStats.tsx), [components/TransactionList.tsx](components/TransactionList.tsx)
- Scripts: `scripts/update_pool_volume_indexer.js`, `scripts/update_holder_rankings.js`
- Data outputs: `public/data/pool_volume.json`, `public/data/holder_rankings.json`, `public/data/pool_volume_checkpoint.json`, `public/data/pool_volume_runs.json`, `public/data/pool_volume_alert.json`
- CI workflows: `.github/workflows/update-pool-volume.yml`, `.github/workflows/update-holder-rankings.yml`

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
- `BACKUP_CHAINSTACK_BASE_RPC_URL` - optional full HTTPS Chainstack Base RPC URL used as a third fallback for Base
- `HOLDER_RANKINGS_ASSET_TRANSFERS_PAGE_SIZE` - optional page size for Alchemy transfer pagination
- `HOLDER_RANKINGS_EXCLUDED_ADDRESSES` - optional comma-separated addresses to hide from the public holder ranking
- `HOLDER_RANKINGS_LOG_CHUNK` - optional initial `eth_getLogs` block span
- `HOLDER_RANKINGS_MIN_LOG_CHUNK` - optional minimum block span after backoff
- `HOLDER_RANKINGS_SAVE_EVERY_BATCHES` - optional save cadence during long bootstrap runs
- `GH_PAT` - CI token used to push generated artifacts
- `POLYGON_USDC` - optional override of the tracked USDC token address for pool volume jobs

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
- `GET /api/pools` - returns pools with computed USD values
- `GET /api/burnStats` - returns aggregated burn totals and per-address balances
- `GET /api/holderRankings` - returns the latest file-backed holder snapshot from `public/data/holder_rankings.json`

## Updater behavior
- The pool volume updater uses Alchemy Asset Transfers first, falls back to JSON-RPC log scans through Infura and then optional Chainstack URLs when needed, and persists per-pool checkpoints.
- The holder rankings updater uses Alchemy Asset Transfers pagination when available, falls back to standard JSON-RPC if needed, keeps cumulative per-holder balances in `data/holder_rankings_state.json`, and writes a public top-500 snapshot.
- The public holder ranking excludes zero/dead/token-contract addresses by default and supports extra exclusions through env vars.
- The first holder rankings run is the expensive bootstrap. Later runs only scan blocks after the last saved checkpoint.

## GitHub Actions
- `.github/workflows/update-pool-volume.yml` runs the pool updater hourly and commits its outputs back to `main`.
- `.github/workflows/update-holder-rankings.yml` runs after the pool updater workflow completes and commits `public/data/holder_rankings.json` plus `data/holder_rankings_state.json` back to `main`.
- Production deploys are expected to come from Vercel's Git integration on pushes to `main`, not from the workflows themselves.

## Data outputs
- `public/data/pool_volume.json` - per-pool cumulative totals
- `public/data/pool_volume_checkpoint.json` - per-pool scan checkpoints
- `public/data/pool_volume_runs.json` - pool updater run history
- `public/data/pool_volume_alert.json` - pool updater alert output
- `public/data/holder_rankings.json` - top-holder snapshot served by `/api/holderRankings`
- `data/holder_rankings_state.json` - non-public cumulative balances and per-chain checkpoints for holder rankings
- `data/holder_labels.json` - manual address labels and exclusion rules for holder rankings

## Troubleshooting
- If pool updates fail, inspect `public/data/pool_volume_alert.json` and `public/data/pool_volume_runs.json`.
- If holder updates fail, run `npm run update:holder-rankings` locally with the same RPC credentials and inspect `data/holder_rankings_state.json`.

## Additional docs
- [docs/pool_volume_automation.md](docs/pool_volume_automation.md)
- [docs/holder_rankings_automation.md](docs/holder_rankings_automation.md)
