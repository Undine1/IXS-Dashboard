import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// This file replays the 2026-07-03 incident (runs 28669908723 / 28676102628):
// Alchemy's alchemy_getAssetTransfers API 429'd while its core JSON-RPC stayed
// healthy, Infura 429'd under the chunked eth_getLogs fallback, and the
// per-URL run-wide provider ban left no provider able to serve eth_getLogs,
// failing every pool. The fix: method-scoped bans plus Alchemy as the
// last-resort log-scan provider.
//
// The script reads provider keys at module load, so set env before requiring
// a fresh copy (imports are hoisted; require is not).
process.env.ALCHEMY_API_KEY = 'test-alchemy-key';
process.env.BACKUP_INFURA_API_KEY = 'test-infura-key';
// Chainstack is base-only; leaving it unset keeps the polygon fallback list
// exactly [infura, alchemy] so the call-count assertions below are exact.
delete process.env.BACKUP_CHAINSTACK_BASE_RPC_URL;
process.env.API_MAX_ATTEMPTS = '3';
process.env.API_BASE_DELAY_MS = '1';
process.env.API_MAX_DELAY_MS = '4';
process.env.RPC_MIN_INTERVAL_MS = '0';
// Pin the log-scan chunk size so the 100-150 block range is one chunk
// regardless of ambient env / .env.local: exactly 2 eth_getLogs calls
// (outgoing + incoming) reach the serving provider.
process.env.RPC_LOG_BLOCK_CHUNK = '1000';
process.env.LOG_CHUNK = '1000';

const requireCjs = createRequire(import.meta.url);
const modulePath = requireCjs.resolve('../scripts/update_pool_volume_indexer.js');
delete requireCjs.cache[modulePath];
const poolVolume = requireCjs(modulePath);

const {
  computeRetryDelayMs,
  providerDisableKey,
  disableProviderForRun,
  getDisabledProviderInfo,
  getLogScanRpcUrlsForChain,
  alchemyCall,
  sumTokenTransfersViaRpc,
} = poolVolume;

interface FakeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function jsonResponse(body: unknown): FakeResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function rateLimited(): FakeResponse {
  return {
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => '{"error":{"code":429,"message":"rate limited"}}',
  };
}

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

test('computeRetryDelayMs keeps a floor of half the exponential step', () => {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const exp = Math.min(30000, 500 * Math.pow(2, attempt - 1));
    for (let i = 0; i < 50; i += 1) {
      const delay = computeRetryDelayMs(attempt, 500, 30000);
      assert.ok(delay >= Math.floor(exp / 2), `attempt ${attempt}: delay ${delay} below floor ${exp / 2}`);
      assert.ok(delay <= exp, `attempt ${attempt}: delay ${delay} above cap ${exp}`);
    }
  }
});

test('providerDisableKey scopes bans to (url, method)', () => {
  const url = 'https://example.com/v2/key';
  assert.equal(providerDisableKey(url, 'eth_getLogs'), providerDisableKey(url, 'eth_getLogs'));
  assert.notEqual(providerDisableKey(url, 'eth_getLogs'), providerDisableKey(url, 'alchemy_getAssetTransfers'));
});

test('disabling one method leaves other methods on the same provider usable', () => {
  const url = 'https://scoped-ban.example.com/v2/key';
  const error = Object.assign(new Error('429 Too Many Requests'), { code: 'RPC_RATE_LIMIT', status: 429 });

  disableProviderForRun(url, 'alchemy_getAssetTransfers', error);

  assert.ok(getDisabledProviderInfo(url, 'alchemy_getAssetTransfers'));
  assert.equal(getDisabledProviderInfo(url, 'eth_getLogs'), null);
});

test('log-scan provider list keeps Infura first and Alchemy as last resort', () => {
  const urls = getLogScanRpcUrlsForChain('polygon');
  assert.ok(urls.length >= 2, `expected at least infura+alchemy, got ${JSON.stringify(urls)}`);
  assert.ok(urls[0].includes('infura.io'), `expected infura first, got ${urls[0]}`);
  assert.ok(urls[urls.length - 1].includes('alchemy.com'), `expected alchemy last, got ${urls[urls.length - 1]}`);
});

test('incident replay: getLogs succeeds via Alchemy after asset-transfers 429 and Infura 429', async () => {
  const pair = `0x${'d'.repeat(40)}`;
  const usdc = `0x${'c'.repeat(40)}`;
  const calls: Array<{ provider: string; method: string }> = [];
  const transferLog = {
    transactionHash: `0x${'1'.repeat(64)}`,
    logIndex: '0x0',
    data: '0x0f4240', // 1_000_000 raw = 1.0 at 6 decimals
  };

  globalThis.fetch = (async (url: string | URL, opts?: { body?: string }) => {
    const host = String(url);
    const { method } = JSON.parse(String((opts && opts.body) || '{}'));
    const provider = host.includes('alchemy.com') ? 'alchemy' : host.includes('infura.io') ? 'infura' : 'other';
    calls.push({ provider, method });

    if (provider === 'infura') return rateLimited();
    if (method === 'alchemy_getAssetTransfers') return rateLimited();
    if (method === 'eth_getLogs') return jsonResponse({ jsonrpc: '2.0', id: 1, result: [transferLog] });
    return jsonResponse({ jsonrpc: '2.0', id: 1, result: null });
  }) as unknown as typeof fetch;

  // Step 1 (as in the incident): the primary Asset Transfers path exhausts its
  // retries and bans alchemy for that method only.
  await assert.rejects(
    () => alchemyCall('polygon', 'alchemy_getAssetTransfers', [{}]),
    /429|rate/i,
  );
  const alchemyUrl = getLogScanRpcUrlsForChain('polygon').find((u: string) => u.includes('alchemy.com'));
  assert.ok(getDisabledProviderInfo(alchemyUrl, 'alchemy_getAssetTransfers'), 'asset-transfers should be banned');
  assert.equal(getDisabledProviderInfo(alchemyUrl, 'eth_getLogs'), null, 'eth_getLogs must not be poisoned');

  // Step 2: the eth_getLogs fallback survives Infura's 429s by falling
  // through to Alchemy core JSON-RPC.
  const total = await sumTokenTransfersViaRpc(100, 150, pair, usdc, 'polygon', 6);
  assert.equal(total, 1);

  const infuraGetLogs = calls.filter((c) => c.provider === 'infura' && c.method === 'eth_getLogs').length;
  const alchemyGetLogs = calls.filter((c) => c.provider === 'alchemy' && c.method === 'eth_getLogs').length;
  // First getLogs call burns Infura's retry budget once, bans it for the
  // method, and later calls skip it entirely instead of re-hammering.
  assert.equal(infuraGetLogs, Number(process.env.API_MAX_ATTEMPTS));
  // outgoing + incoming scan for the single chunk, both served by Alchemy
  assert.equal(alchemyGetLogs, 2);
});
