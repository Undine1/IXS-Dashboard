import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Verifies incremental checkpointing: each scanned window commits its own
// volume delta + a checkpoint at its last block, so an interrupted scan of a
// large backlog keeps its progress and the next run resumes without
// rescanning (which would double-count) or losing a window.
process.env.ALCHEMY_API_KEY = 'test-alchemy-key';
process.env.BACKUP_INFURA_API_KEY = 'test-infura-key';
delete process.env.BACKUP_CHAINSTACK_BASE_RPC_URL; // polygon fallback = [infura, alchemy]
process.env.API_MAX_ATTEMPTS = '2';
process.env.API_BASE_DELAY_MS = '1';
process.env.API_MAX_DELAY_MS = '4';
process.env.RPC_MIN_INTERVAL_MS = '0';
process.env.RPC_LOG_BLOCK_CHUNK = '10';
process.env.RPC_MIN_LOG_BLOCK_CHUNK = '10';

const requireCjs = createRequire(import.meta.url);
const modulePath = requireCjs.resolve('../scripts/update_pool_volume_indexer.js');
delete requireCjs.cache[modulePath];
const poolVolume = requireCjs(modulePath);
const { sumTokenTransfersViaRpc, sumTokenTransfersViaAlchemyAssetTransfers } = poolVolume;

interface FakeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}
function ok(body: unknown): FakeResponse {
  return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}
function rateLimited(): FakeResponse {
  return { ok: false, status: 429, statusText: 'Too Many Requests', headers: { get: () => null }, json: async () => ({}), text: async () => '{"error":{"code":429,"message":"Too Many Requests"}}' };
}

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

const pair = `0x${'d'.repeat(40)}`;
const usdc = `0x${'c'.repeat(40)}`;

test('eth_getLogs scan commits per-window progress and stops at the failing window', async () => {
  // Blocks 0-9 -> value 5, 10-19 -> value 3, 20+ -> every provider 429s.
  // Expect commits for windows 9 and 19 only, then a throw, with no commit for
  // the failed 20-29 window (so the next run rescans it without double-count).
  globalThis.fetch = (async (url: string | URL, opts?: { body?: string }) => {
    const body = JSON.parse(String((opts && opts.body) || '{}'));
    const p = body.params && body.params[0];
    const from = parseInt(p.fromBlock, 16);
    const outgoing = Array.isArray(p.topics) && p.topics.length === 2;
    if (from >= 20) return rateLimited();
    const logs: Array<{ transactionHash: string; logIndex: string; data: string }> = [];
    if (outgoing && from < 10) logs.push({ transactionHash: `0x${'1'.repeat(64)}`, logIndex: '0x0', data: '0x05' });
    if (outgoing && from >= 10 && from < 20) logs.push({ transactionHash: `0x${'2'.repeat(64)}`, logIndex: '0x0', data: '0x03' });
    return ok({ jsonrpc: '2.0', id: 1, result: logs });
  }) as unknown as typeof fetch;

  const commits: Array<[number, bigint]> = [];
  const onProgress = (blockEnd: number, raw: bigint) => commits.push([blockEnd, raw]);

  await assert.rejects(
    () => sumTokenTransfersViaRpc(0, 29, pair, usdc, 'polygon', 0, onProgress),
    /Failed eth_getLogs scan for polygon blocks 20-29/,
  );

  assert.deepEqual(commits, [
    [9, 5n],
    [19, 3n],
  ], 'committed windows 0-9 (5) and 10-19 (3); nothing for the failed 20-29');
});

test('eth_getLogs scan stops immediately when canonical progress persistence fails', async () => {
  const originalMaxChunk = process.env.RPC_LOG_BLOCK_CHUNK;
  const originalMinChunk = process.env.RPC_MIN_LOG_BLOCK_CHUNK;
  process.env.RPC_LOG_BLOCK_CHUNK = '20';
  process.env.RPC_MIN_LOG_BLOCK_CHUNK = '10';
  const requestedFromBlocks: number[] = [];

  globalThis.fetch = (async (_url: string | URL, opts?: { body?: string }) => {
    const body = JSON.parse(String((opts && opts.body) || '{}'));
    const p = body.params && body.params[0];
    const from = parseInt(p.fromBlock, 16);
    requestedFromBlocks.push(from);
    const outgoing = Array.isArray(p.topics) && p.topics.length === 2;
    const logs = outgoing
      ? [{ transactionHash: `0x${'3'.repeat(64)}`, logIndex: '0x0', data: '0x05' }]
      : [];
    return ok({ jsonrpc: '2.0', id: 1, result: logs });
  }) as unknown as typeof fetch;

  let commitAttempts = 0;
  try {
    await assert.rejects(
      () => sumTokenTransfersViaRpc(0, 39, pair, usdc, 'ethereum', 0, () => {
        commitAttempts += 1;
        throw Object.assign(new Error('canonical state write failed'), {
          code: 'POOL_STATE_PERSIST_FAILED',
        });
      }),
      (error: unknown) => error instanceof Error &&
        (error as Error & { code?: string }).code === 'POOL_STATE_PERSIST_FAILED',
    );
    assert.equal(commitAttempts, 1);
    assert.deepEqual(requestedFromBlocks, [0, 0], 'no later block window is scanned');
  } finally {
    if (originalMaxChunk === undefined) delete process.env.RPC_LOG_BLOCK_CHUNK;
    else process.env.RPC_LOG_BLOCK_CHUNK = originalMaxChunk;
    if (originalMinChunk === undefined) delete process.env.RPC_MIN_LOG_BLOCK_CHUNK;
    else process.env.RPC_MIN_LOG_BLOCK_CHUNK = originalMinChunk;
  }
});

// Each test uses a distinct chain: the disabled-provider map is module-level
// and keyed by (method, url), so a ban raised in one test would otherwise leak
// into the next via the shared module instance.
test('eth_getLogs per-window deltas sum to the same total the return value reports', async () => {
  globalThis.fetch = (async (url: string | URL, opts?: { body?: string }) => {
    const body = JSON.parse(String((opts && opts.body) || '{}'));
    const p = body.params && body.params[0];
    const from = parseInt(p.fromBlock, 16);
    const outgoing = Array.isArray(p.topics) && p.topics.length === 2;
    const logs: Array<{ transactionHash: string; logIndex: string; data: string }> = [];
    if (outgoing && from < 10) logs.push({ transactionHash: `0x${'a'.repeat(64)}`, logIndex: '0x0', data: '0x07' });
    if (outgoing && from >= 10 && from < 20) logs.push({ transactionHash: `0x${'b'.repeat(64)}`, logIndex: '0x0', data: '0x02' });
    return ok({ jsonrpc: '2.0', id: 1, result: logs });
  }) as unknown as typeof fetch;

  const commits: bigint[] = [];
  const total = await sumTokenTransfersViaRpc(0, 19, pair, usdc, 'base', 6, (_b: number, raw: bigint) => commits.push(raw));

  assert.equal(total, 9 / 1e6, 'return total = (7 + 2) raw scaled by 6 decimals');
  assert.equal(commits.reduce((a, b) => a + b, 0n), 9n, 'committed raw deltas sum to the full scanned volume (no double count, no gap)');
});

test('asset-transfers path commits once atomically at the range end', async () => {
  globalThis.fetch = (async (url: string | URL, opts?: { body?: string }) => {
    const body = JSON.parse(String((opts && opts.body) || '{}'));
    if (body.method !== 'alchemy_getAssetTransfers') return ok({ jsonrpc: '2.0', id: 1, result: null });
    const params = body.params[0];
    const outgoing = typeof params.fromAddress === 'string';
    // One outgoing transfer of raw value 12; incoming empty. Single page.
    const transfers = outgoing
      ? [{ uniqueId: 'x1', rawContract: { value: '0x0c' } }]
      : [];
    return ok({ jsonrpc: '2.0', id: 1, result: { transfers, pageKey: null } });
  }) as unknown as typeof fetch;

  const commits: Array<[number, bigint]> = [];
  const total = await sumTokenTransfersViaAlchemyAssetTransfers(
    100,
    900,
    pair,
    usdc,
    'ethereum',
    6,
    (blockEnd: number, raw: bigint) => commits.push([blockEnd, raw]),
  );

  assert.equal(total, 12 / 1e6);
  assert.deepEqual(commits, [[900, 12n]], 'exactly one commit, at endBlock, with the full raw total');
});
