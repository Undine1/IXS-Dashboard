#!/usr/bin/env node
// Legacy entrypoint retained for compatibility with existing docs/workflows.
// The indexer updater is now the single supported implementation.
const { spawnSync } = require('child_process');
const path = require('path');

const script = path.join(__dirname, 'update_pool_volume_indexer.js');

console.warn(
  '[update_pool_volume_rpc] This command is deprecated and now delegates to update_pool_volume_indexer.js.'
);

const result = spawnSync(process.execPath, [script], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error('[update_pool_volume_rpc] Failed to run delegated updater:', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
