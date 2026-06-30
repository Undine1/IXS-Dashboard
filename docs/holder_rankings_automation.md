# Holder Rankings Automation

Summary of the holder rankings updater and automation in this repo.

What it does
- Pages ERC-20 transfer history for the configured IXS token contracts on Ethereum, Base, and Polygon.
- Maintains a private incremental state file at `data/holder_rankings_state.json`.
- Writes the public top-holder snapshot to `public/data/holder_rankings.json`.
- Runs via GitHub Actions as the second step of the hourly `Update Dashboard Data` workflow, after the pool-volume updater, and is committed together with the pool data in a single push.
- Excludes burn/system addresses from the public ranking snapshot while keeping full balances in private state.

Why this replaces Dune
- No Dune credits.
- No expiring Dune schedules.
- Daily refresh cost scales with new transfers since the previous checkpoint instead of a full historical recomputation.

Files of interest
- `scripts/update_holder_rankings.js` - incremental RPC-based updater.
- `app/api/holderRankings/route.ts` - file-backed API route consumed by the app.
- `public/data/holder_rankings.json` - public snapshot used by the UI.
- `data/holder_rankings_state.json` - incremental private state and checkpoints (gitignored; persisted on the `refs/data-state` ref between runs, not committed to `main`).
- `data/holder_labels.json` - manual address labels and exclusion rules.
- `.github/workflows/update-dashboard-data.yml` - hourly automation that runs the pool-volume updater and then this updater, committing all refreshed artifacts in one push.

How the updater works
1. Loads the saved state from `data/holder_rankings_state.json` if present.
2. For each configured chain:
   - Resolves the token contract deployment block if no checkpoint exists yet.
   - Uses `ALCHEMY_API_KEY` for `alchemy_getAssetTransfers`.
   - Falls back to standard JSON-RPC using `ALCHEMY_API_KEY`, then `BACKUP_INFURA_API_KEY`, then `BACKUP_CHAINSTACK_BASE_RPC_URL` on Base if needed.
   - Pages transfer history with `alchemy_getAssetTransfers`, then falls back to `eth_getLogs` if the Alchemy-specific path is unavailable.
   - If the Alchemy path fails mid-range, rolls the chain back to its pre-attempt snapshot before falling back to `eth_getLogs`.
   - Applies balance deltas per holder in raw token units.
   - Reconciles any holder whose Transfer-event sum goes negative against the
     authoritative on-chain `balanceOf` (see "Non-standard token" below).
3. Rebuilds the combined top-500 snapshot.
4. Writes the updated state and public JSON artifacts.

Non-standard token (why balances are reconciled)
- IXS is not a vanilla ERC-20: its `balanceOf` is changed by mechanics that do
  not emit `Transfer` events (e.g. reflections/fees/migration credits). This was
  confirmed empirically — summing every `Transfer` event for a high-volume
  pass-through address (via both Alchemy asset-transfers and Etherscan, which
  agree on the event set) yields a *negative* net, which is impossible for a
  standard token, while the real `balanceOf` is positive.
- Consequence: reconstructing balances purely by summing transfers is
  approximate, and for high-volume churning addresses (market makers, routers)
  the running sum can legitimately go below zero even with a complete, correct
  event history.
- Handling: when a holder's event sum would go negative, the updater does NOT
  fail the run and does NOT silently clamp to zero. It records the address,
  continues the scan, and after the chain completes replaces each flagged
  holder's balance with its on-chain `balanceOf` at the scanned block (one
  `eth_call` per flagged address — typically a handful per run). These addresses
  hold ~nothing (they only pass volume through), so they never appear in the
  top-N ranking; reconciliation simply prevents them from breaking the run.

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
  - `BACKUP_CHAINSTACK_BASE_RPC_URL` as the full HTTPS Chainstack Base RPC endpoint
- Optional holder updater tuning:
  - `HOLDER_RANKINGS_LIMIT` (default `600`) — rows kept in the public snapshot. The UI
    displays a top 500 (`HOLDER_DISPLAY_LIMIT` in `components/BurnStats.tsx`); the extra
    100 are intentional leeway so that when named holders (contracts/bridges/exchanges)
    are hidden, the list can still fill to a full 500 unnamed entries. Keep this
    comfortably above the display limit.
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
- Negative event-sum balances are expected for IXS and are reconciled against on-chain `balanceOf` rather than failing the run (see "Non-standard token" above). A run that logs many reconciliations is normal for high-volume addresses; only a `balanceOf reconciliation failed` warning (an RPC error) needs attention, and it self-corrects on the next run.

Running locally
1. Put `ALCHEMY_API_KEY` in `.env.local`.
2. Optionally add `BACKUP_INFURA_API_KEY` as an Infura project key.
3. Optionally add `BACKUP_CHAINSTACK_BASE_RPC_URL` with the full Base HTTPS endpoint.
4. Run:
   ```bash
   npm run update:holder-rankings
   ```
5. Confirm the outputs:
   - `public/data/holder_rankings.json`
   - `data/holder_rankings_state.json`

GitHub Actions setup
- Required secrets:
  - `GH_PAT`
- RPC secrets:
  - `ALCHEMY_API_KEY`
  - optional `BACKUP_INFURA_API_KEY`
  - optional `BACKUP_CHAINSTACK_BASE_RPC_URL`
- Optional repository variables:
  - `HOLDER_RANKINGS_LOG_CHUNK`
  - `HOLDER_RANKINGS_MIN_LOG_CHUNK`
  - `HOLDER_RANKINGS_SAVE_EVERY_BATCHES`
  - `HOLDER_RANKINGS_*_START_BLOCK`

Operational notes
- The app still reads `/api/holderRankings`; only the data source changed.
- The snapshot file is the only data served publicly.
- The state file is not served by Next.js and is not committed to `main`. It is persisted between scheduled runs on the custom ref `refs/data-state` as a single parentless (orphan) commit — durable in the repo but with no growing history, and invisible to Vercel, `on: push` workflows, and normal clones (custom refs are not fetched by default). The workflow restores it before the updater and force-pushes the refreshed state after. It is also uploaded as a per-run CI artifact as a backup. If the ref is ever lost, the next run bootstraps a full rescan from the token deployment block (expensive but self-healing).
- The holder step runs even when the pool updater step in the same job failed (and vice versa) — the two datasets are independent, so one updater's failure does not leave the other's data stale. The commit step likewise pushes whatever valid progress exists.
- Vercel deployment for refreshed data is expected to come from Git integration when the workflow pushes to `main` (one push per run covering both updaters).
- State and snapshot writes use a temp-file replace flow so scheduled runs do not leave partially written JSON behind.
- On Alchemy Free, `eth_getLogs` is severely block-range limited; the Alchemy Asset Transfers path remains the preferred primary path.
- By default the public ranking excludes the zero address, `0x...dead`, and the three token contract addresses. Use the exclusion env vars above to add project-specific burn or treasury addresses.
