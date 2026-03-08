# Holder Rankings Automation

Summary of the holder rankings updater and automation in this repo.

What it does
- Pages ERC-20 transfer history for the configured IXS token contracts on Ethereum, Base, and Polygon.
- Maintains a private incremental state file at `data/holder_rankings_state.json`.
- Writes the public top-holder snapshot to `public/data/holder_rankings.json`.
- Runs hourly via GitHub Actions and commits updated artifacts back to the repo.
- Excludes burn/system addresses from the public ranking snapshot while keeping full balances in private state.

Why this replaces Dune
- No Dune credits.
- No expiring Dune schedules.
- Daily refresh cost scales with new transfers since the previous checkpoint instead of a full historical recomputation.

Files of interest
- `scripts/update_holder_rankings.js` - incremental RPC-based updater.
- `app/api/holderRankings/route.ts` - file-backed API route consumed by the app.
- `public/data/holder_rankings.json` - public snapshot used by the UI.
- `data/holder_rankings_state.json` - incremental private state and checkpoints.
- `data/holder_labels.json` - manual address labels and exclusion rules.
- `.github/workflows/update-holder-rankings.yml` - hourly automation and deploy flow.

How the updater works
1. Loads the saved state from `data/holder_rankings_state.json` if present.
2. For each configured chain:
   - Resolves the token contract deployment block if no checkpoint exists yet.
   - Uses `ALCHEMY_API_KEY` for `alchemy_getAssetTransfers`.
   - Falls back to standard JSON-RPC using `ALCHEMY_API_KEY`, then `BACKUP_INFURA_API_KEY` if needed.
   - Pages transfer history with `alchemy_getAssetTransfers`, then falls back to `eth_getLogs` if the Alchemy-specific path is unavailable.
   - Applies balance deltas per holder in raw token units.
3. Rebuilds the combined top-500 snapshot.
4. Writes the updated state and public JSON artifacts.

Label registry
- `data/holder_labels.json` is a committed registry keyed by address.
- Supported fields per address:
  - `label` - friendly display name shown in the UI
  - `category` - short tag such as `bridge`, `protocol`, `burn`, `contract`, or `system`
  - `excludeFromRanking` - if `true`, the address is removed from the public ranking snapshot
- This is the preferred place to maintain known wallet names over time.

Configuration
- Set `ALCHEMY_API_KEY` and let the script derive the three chain RPC endpoints.
- Optional:
  - `BACKUP_INFURA_API_KEY` as an Infura project key for fallback
- Optional holder updater tuning:
  - `HOLDER_RANKINGS_LIMIT` (default `600`)
  - `HOLDER_RANKINGS_EXCLUDED_ADDRESSES` (comma-separated global exclusion list)
  - `HOLDER_RANKINGS_ETHEREUM_EXCLUDED_ADDRESSES`
  - `HOLDER_RANKINGS_BASE_EXCLUDED_ADDRESSES`
  - `HOLDER_RANKINGS_POLYGON_EXCLUDED_ADDRESSES`
  - `HOLDER_RANKINGS_ASSET_TRANSFERS_PAGE_SIZE` (default `1000`)
  - `HOLDER_RANKINGS_LOG_CHUNK` (default `20000`)
  - `HOLDER_RANKINGS_MIN_LOG_CHUNK` (default `500`)
  - `HOLDER_RANKINGS_SAVE_EVERY_BATCHES` (default `10`)
- Optional token overrides:
  - `HOLDER_RANKINGS_ETHEREUM_TOKEN_ADDRESS`
  - `HOLDER_RANKINGS_BASE_TOKEN_ADDRESS`
  - `HOLDER_RANKINGS_POLYGON_TOKEN_ADDRESS`
- Optional manual bootstrap shortcuts:
  - `HOLDER_RANKINGS_ETHEREUM_START_BLOCK`
  - `HOLDER_RANKINGS_BASE_START_BLOCK`
  - `HOLDER_RANKINGS_POLYGON_START_BLOCK`

Bootstrap notes
- The first run is the expensive one because it backfills from the token deployment block to the current head.
- The script finds the deployment block automatically with `eth_getCode` binary search.
- If you already know the deployment blocks, setting the `HOLDER_RANKINGS_*_START_BLOCK` variables will shorten the bootstrap.
- If the script throws a negative-balance error, the saved state is incomplete or the configured start block is too recent.

Running locally
1. Put `ALCHEMY_API_KEY` in `.env.local`.
2. Optionally add `BACKUP_INFURA_API_KEY` as an Infura project key.
3. Run:
   ```bash
   npm run update:holder-rankings
   ```
4. Confirm the outputs:
   - `public/data/holder_rankings.json`
   - `data/holder_rankings_state.json`

GitHub Actions setup
- Required secrets:
  - `GH_PAT`
  - `VERCEL_TOKEN`
  - `VERCEL_ORG_ID`
  - `VERCEL_PROJECT_ID`
- RPC secrets:
  - `ALCHEMY_API_KEY`
  - optional `BACKUP_INFURA_API_KEY`
- Optional repository variables:
  - `HOLDER_RANKINGS_LOG_CHUNK`
  - `HOLDER_RANKINGS_MIN_LOG_CHUNK`
  - `HOLDER_RANKINGS_SAVE_EVERY_BATCHES`
  - `HOLDER_RANKINGS_*_START_BLOCK`

Operational notes
- The app still reads `/api/holderRankings`; only the data source changed.
- The snapshot file is the only data served publicly.
- The state file is committed to the repo for persistence between scheduled runs, but it is not served by Next.js.
- On Alchemy Free, `eth_getLogs` is severely block-range limited; the Alchemy Asset Transfers path remains the preferred primary path.
- By default the public ranking excludes the zero address, `0x...dead`, and the three token contract addresses. Use the exclusion env vars above to add project-specific burn or treasury addresses.
