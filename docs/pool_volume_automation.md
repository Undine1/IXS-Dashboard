# Pool Volume Automation

Summary of the updater and automation in this repo.

What it does
- Persists per-pool lifetime USD totals to `public/data/pool_volume.json`.
- Runs an hourly updater (`scripts/update_pool_volume_indexer.js`) via GitHub Actions.
- Uses Alchemy Asset Transfers with an Infura log-scan fallback to:
  - Resolve timestamps to blocks via binary search.
  - Fetch ERC-20 transfers via `alchemy_getAssetTransfers`.
  - Fall back to `eth_getLogs` through Infura when the Alchemy-specific path is unavailable.
- Applies retry logic with backoff/jitter for transient failures.
- Persists per-pool checkpoints in `public/data/pool_volume_checkpoint.json`.
- Appends run summaries to `public/data/pool_volume_runs.json`.
- Writes `public/data/pool_volume_alert.json` when retry budgets are exhausted.

Configuration
- Local (`.env.local`): set `ALCHEMY_API_KEY`.
  - The updater auto-loads `.env.local` when these variables are not already exported.
- CI (GitHub Actions): set `ALCHEMY_API_KEY` as a repository secret.
- Optional:
  - `BACKUP_INFURA_API_KEY` as an Infura project key for fallback when the primary Alchemy key is rate-limited or temporarily blocked.
- Optional:
  - `POLYGON_USDC` to override the default tracked USDC address.
  - `PAIR_ADDRESS` to override a default pool address.
  - `WINDOW_SECONDS` to control the incremental time window (default `3600`).
  - `POOL_VOLUME_ASSET_TRANSFERS_PAGE_SIZE` to control Alchemy transfer page size (default `1000`).
  - `RPC_LOG_BLOCK_CHUNK` to control fallback `eth_getLogs` block span (default `500`, workflow sets `200`).
  - `RPC_MIN_LOG_BLOCK_CHUNK` to control the minimum fallback log span after backoff (default `10`).

Files of interest
- `scripts/update_pool_volume_indexer.js` - primary updater.
- `public/data/pool_volume.json` - persisted totals.
- `public/data/pool_volume_checkpoint.json` - per-pool checkpoints.
- `public/data/pool_volume_runs.json` - run history.
- `.github/workflows/update-pool-volume.yml` - scheduled automation and deploy flow.

Operational notes
- The updater uses `ALCHEMY_API_KEY` first for Ethereum, Polygon, and Base.
- Pool transfer fetching prefers `alchemy_getAssetTransfers`, which avoids the tight `eth_getLogs` block-range limits on Alchemy Free.
- `BACKUP_INFURA_API_KEY` is used for the Infura-only `eth_getLogs` fallback.
- If the Alchemy transfer API path fails, the updater falls back to standard RPC log scanning through Infura.
- If rate-limited, tune retry settings with:
  - `API_MAX_ATTEMPTS`
  - `API_BASE_DELAY_MS`
  - `API_MAX_DELAY_MS`
- Check `pool_volume_alert.json` when a CI run fails to identify the failing pool/API call.
