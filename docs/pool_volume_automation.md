# Pool Volume Automation

Summary of the updater and automation in this repo.

What it does
- Persists per-pool lifetime USD totals to `public/data/pool_volume.json`.
- Runs an hourly updater (`scripts/update_pool_volume_indexer.js`) via GitHub Actions.
- Uses Etherscan-compatible V2 APIs to:
  - Resolve timestamp to block (`module=block&action=getblocknobytime`).
  - Fetch token transfer history (`module=account&action=tokentx`).
- Applies retry logic with backoff/jitter for transient failures.
- Persists per-pool checkpoints in `public/data/pool_volume_checkpoint.json`.
- Appends run summaries to `public/data/pool_volume_runs.json`.
- Writes `public/data/pool_volume_alert.json` when retry budgets are exhausted.

Configuration
- Local (`.env.local`): set `ETHERSCAN_API_KEY` (recommended default).
  - The updater auto-loads `.env.local` when these variables are not already exported.
- CI (GitHub Actions): set `ETHERSCAN_API_KEY` as a repository secret.
- Optional per-chain keys:
  - `POLYGONSCAN_API_KEY` for Polygon-native explorer access.
  - `BASESCAN_API_KEY` for Base-native explorer access.
  - These help avoid Etherscan V2 cross-chain plan restrictions.
- Optional RPC fallbacks:
  - `BASE_RPC` / `BASE_RPC_LIST` for Base RPC log-scanning fallback.
  - `POLYGON_RPC` / `POLYGON_RPC_LIST` for Polygon RPC log-scanning fallback.
- Optional:
  - `POLYGON_USDC` to override the default tracked USDC address.
  - `PAIR_ADDRESS` to override a default pool address.
  - `WINDOW_SECONDS` to control the incremental time window (default `3600`).

Files of interest
- `scripts/update_pool_volume_indexer.js` - primary updater.
- `public/data/pool_volume.json` - persisted totals.
- `public/data/pool_volume_checkpoint.json` - per-pool checkpoints.
- `public/data/pool_volume_runs.json` - run history.
- `.github/workflows/update-pool-volume.yml` - scheduled automation and deploy flow.

Operational notes
- The updater primarily uses indexer APIs.
- If a chain is blocked by explorer plan limits, the updater can automatically fall back to RPC (`eth_getLogs`) for that pool.
- If rate-limited, tune retry settings with:
  - `API_MAX_ATTEMPTS`
  - `API_BASE_DELAY_MS`
  - `API_MAX_DELAY_MS`
- Check `pool_volume_alert.json` when a CI run fails to identify the failing pool/API call.
