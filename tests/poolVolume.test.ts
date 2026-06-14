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
  pruneCheckpoint,
  getAssetTransferRawValue,
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
