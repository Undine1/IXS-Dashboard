import { test } from 'node:test';
import assert from 'node:assert/strict';
import poolVolume from '../scripts/update_pool_volume_indexer.js';

const {
  classifyRpcErrorMessage,
  shouldDisableProviderForRun,
  normalizeChain,
  asRpcHex,
  fromRpcHex,
  addrToTopic,
  isValidAddress,
  toEpochSeconds,
  clampCheckpointBlock,
  pruneCheckpoint,
  getAssetTransferRawValue,
  selectAuthoritativeCheckpoint,
  buildPoolState,
  getLatestBlockNumberForRun,
  commitPoolProgress,
} = poolVolume;

test('classifyRpcErrorMessage buckets known failure shapes', () => {
  assert.equal(classifyRpcErrorMessage('over rate limit'), 'RPC_RATE_LIMIT');
  assert.equal(classifyRpcErrorMessage('request timed out'), 'RPC_TIMEOUT');
  assert.equal(classifyRpcErrorMessage('too many requests'), 'RPC_RATE_LIMIT');
  assert.equal(classifyRpcErrorMessage('boom'), 'RPC_ERROR');
});

test('shouldDisableProviderForRun trips on auth/rate-limit signals', () => {
  assert.equal(shouldDisableProviderForRun({ status: 429 }), true);
  assert.equal(shouldDisableProviderForRun({ code: 'RPC_FORBIDDEN' }), true);
  assert.equal(shouldDisableProviderForRun({ message: 'unauthorized' }), true);
  assert.equal(shouldDisableProviderForRun({ message: 'execution reverted' }), false);
});

test('normalizeChain accepts supported chains and rejects others', () => {
  assert.equal(normalizeChain('Polygon'), 'polygon');
  assert.throws(() => normalizeChain(''), /Missing chain/);
  assert.throws(() => normalizeChain('solana'), /Unsupported chain/);
});

test('asRpcHex/fromRpcHex round-trip block numbers', () => {
  assert.equal(asRpcHex(255), '0xff');
  assert.equal(asRpcHex(-5), '0x0'); // clamped to 0
  assert.equal(fromRpcHex('0xff'), 255);
  assert.ok(Number.isNaN(fromRpcHex('not-hex')));
});

test('addrToTopic left-pads an address to 32 bytes', () => {
  assert.equal(addrToTopic(`0x${'a'.repeat(40)}`), `0x${'0'.repeat(24)}${'a'.repeat(40)}`);
});

test('isValidAddress validates 20-byte hex', () => {
  assert.equal(isValidAddress(`0x${'a'.repeat(40)}`), true);
  assert.equal(isValidAddress('0xabc'), false);
  assert.equal(isValidAddress(null), false);
});

test('toEpochSeconds normalizes seconds and milliseconds', () => {
  assert.equal(toEpochSeconds(1_700_000_000), 1_700_000_000);
  assert.equal(toEpochSeconds(1_700_000_000_000), 1_700_000_000); // ms -> s
  assert.equal(toEpochSeconds(0), null);
  assert.equal(toEpochSeconds('nope'), null);
});

test('clampCheckpointBlock never moves the checkpoint backward', () => {
  // A lagging provider's head must not regress lastBlock (rescanning
  // already-summed blocks would double-count into total_usd).
  assert.equal(clampCheckpointBlock(48233100, 48233095), 48233100);
  assert.equal(clampCheckpointBlock(48233100, 48233200), 48233200);
  assert.equal(clampCheckpointBlock(null, 48233095), 48233095); // no prior checkpoint
  assert.equal(clampCheckpointBlock(undefined, 7), 7);
  assert.equal(clampCheckpointBlock('48233100', 48233095), 48233100); // string-typed legacy value
});

test('pruneCheckpoint drops stale keys and keeps tracked pools', () => {
  const pool = `0x${'a'.repeat(40)}`;
  const removedPool = `0x${'b'.repeat(40)}`;
  const checkpoint: Record<string, unknown> = {
    [pool]: { lastTimestamp: 1, lastBlock: 2 },
    [`${pool}-polygon`]: { lastTimestamp: 1, lastBlock: 2 }, // legacy key, still migratable
    [`${pool}-base`]: { lastTimestamp: 1, lastBlock: 2 }, // wrong-chain legacy key
    [removedPool]: { lastTimestamp: 1, lastBlock: 2 }, // pool no longer tracked
    lastTimestamp: 1, // root-level leftovers from old formats
    lastBlock: 2,
  };

  const pruned = pruneCheckpoint(checkpoint, { [pool]: { chain: 'polygon' } });

  assert.equal(pruned, 4);
  assert.deepEqual(Object.keys(checkpoint).sort(), [pool, `${pool}-polygon`].sort());
});

test('getAssetTransferRawValue parses hex value and defaults to 0n', () => {
  assert.equal(getAssetTransferRawValue({ rawContract: { value: '0x0a' } }), 10n);
  assert.equal(getAssetTransferRawValue({}), 0n);
  assert.equal(getAssetTransferRawValue({ rawContract: { value: 'bad' } }), 0n);
});

test('embedded checkpoints are authoritative over a stale compatibility mirror', () => {
  const embedded = { pool: { lastTimestamp: 20, lastBlock: 200 } };
  const staleMirror = { pool: { lastTimestamp: 10, lastBlock: 100 } };

  assert.equal(
    selectAuthoritativeCheckpoint({ pools: {}, checkpoints: embedded }, staleMirror),
    embedded,
  );
  assert.equal(selectAuthoritativeCheckpoint({ pools: {} }, staleMirror), staleMirror);
});

test('pool state stores totals and checkpoints in the same atomic payload', () => {
  const pools = { pool: { total_usd: 12.5 } };
  const checkpoints = { pool: { lastTimestamp: 20, lastBlock: 200 } };
  const state = buildPoolState(pools, checkpoints, '2026-01-01T00:00:00.000Z');

  assert.deepEqual(state, {
    pools,
    checkpoints,
    lastUpdated: '2026-01-01T00:00:00.000Z',
  });
});

test('latest block number is fetched once per chain per run', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x2a' }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;

  try {
    assert.equal(await getLatestBlockNumberForRun('ethereum'), 42);
    assert.equal(await getLatestBlockNumberForRun('ethereum'), 42);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('failed canonical state writes roll back in-memory pool progress', () => {
  const addr = `0x${'c'.repeat(40)}`;
  const legacyKey = `${addr}-polygon`;
  const pools = { [addr]: { total_usd: 10, lastUpdated: 'old' } };
  const checkpoint = {
    [addr]: { lastTimestamp: 1, lastBlock: 1 },
    [legacyKey]: { lastTimestamp: 0, lastBlock: 0 },
  };

  assert.throws(
    () => commitPoolProgress(
      pools,
      checkpoint,
      {
        addr,
        legacyCheckpointKey: legacyKey,
        endTs: 2,
        windowEndBlock: 2,
        increment: 5,
      },
      () => {
        throw new Error('disk full');
      },
    ),
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === 'POOL_STATE_PERSIST_FAILED',
  );
  assert.deepEqual(pools[addr], { total_usd: 10, lastUpdated: 'old' });
  assert.deepEqual(checkpoint[addr], { lastTimestamp: 1, lastBlock: 1 });
  assert.deepEqual(checkpoint[legacyKey], { lastTimestamp: 0, lastBlock: 0 });
});
