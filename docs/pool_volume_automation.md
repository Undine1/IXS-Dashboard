# Pool Volume Automation

Summary of the updater and automation added to this repo.

What it does
- Persists per-pool lifetime USD totals to `public/data/pool_volume.json`.
- Runs a daily updater (`scripts/update_pool_volume_indexer.js`) that:
  - Binary-searches blocks to compute an exact 24h window.
  - Fetches USDC `Transfer` logs via RPC with chunking and retries.
  - Deduplicates and sums USDC transfers (6 decimals) to compute daily USD.
  - Persists per-pool `lastProcessedBlock` to make runs idempotent.
  - Falls back to Etherscan V2 (`chain=137`) `tokentx` endpoint when RPC fails.
  - Supports multiple RPC endpoints via `POLYGON_RPC_LIST` (round-robin failover).
  - Appends a run summary to `public/data/pool_volume_runs.json` for audit/history.

Configuration
- Local (.env.local): set `ETHERSCAN_API_KEY` (indexer API key) for indexer fallback.
- CI (GitHub Actions): set `ETHERSCAN_API_KEY` as a repository secret. The workflow reads `ETHERSCAN_API_KEY`.
- Optional: `POLYGON_RPC_LIST` (comma-separated) to provide provider failover endpoints.

Files of interest
- `scripts/update_pool_volume_indexer.js` — indexer updater script (uses `ETHERSCAN_API_KEY`) with failover logic.
- `public/data/pool_volume.json` — persisted totals written by the updater.
- `public/data/pool_volume_runs.json` — run history (audit log) appended each run.
- `.github/workflows/update-pool-volume.yml` — scheduled workflow that runs the updater and deploys to Vercel.

Operational notes
- RPC providers may rate-limit or reject large `eth_getLogs` ranges; the script uses chunking/sub-chunking and retries.
- Etherscan V2 (or chain-specific indexer endpoints) is used as a reliable fallback but has its own rate-limits; add an indexer API key (`ETHERSCAN_API_KEY`) to improve quota.
- To reduce fallback frequency, add more RPC endpoints to `POLYGON_RPC_LIST` or use a paid provider.

If you want, I can:
- Add provider success metrics into the run summary (which provider returned the logs).
- Convert the updater to TypeScript and add unit tests.
- Add GitHub Action artifact upload of `pool_volume_runs.json` after each run for easier inspection.

