import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Replays the base-pool failure from 2026-07-04 (run 28702062547) and verifies
// the restored free-tier range handling recovers it:
//   alchemy_getAssetTransfers 429 (primary) -> eth_getLogs fallback ->
//   Infura 429, Chainstack 403, Alchemy 400 "up to a 10 block range" -> the
//   scan must shrink to 10 and complete via Alchemy core RPC, NOT give up.
// Before the fix, the isProviderAccessError short-circuit threw on the Infura
// 429 riding in the same aggregate error, so the 10-block Alchemy path was
// never retried and every base run failed.
//
// Module-level provider config is read at load time, so set env before a fresh
// require. Chainstack is configured here (base-only) so the 403 is in the mix.
process.env.ALCHEMY_API_KEY = 'test-alchemy-key';
process.env.BACKUP_INFURA_API_KEY = 'test-infura-key';
process.env.BACKUP_CHAINSTACK_BASE_RPC_URL = 'https://base-mainnet.core.chainstack.com/test';
process.env.API_MAX_ATTEMPTS = '3';
process.env.API_BASE_DELAY_MS = '1';
process.env.API_MAX_DELAY_MS = '4';
process.env.RPC_MIN_INTERVAL_MS = '0';
process.env.RPC_LOG_BLOCK_CHUNK = '200';
process.env.RPC_MIN_LOG_BLOCK_CHUNK = '10';

const requireCjs = createRequire(import.meta.url);
const modulePath = requireCjs.resolve('../scripts/update_pool_volume_indexer.js');
delete requireCjs.cache[modulePath];
const poolVolume = requireCjs(modulePath);

const { inferMaxLogRangeFromError, sumTokenTransfersViaRpc, getLogScanRpcUrlsForChain, getPublicRpcUrlsForChain } = poolVolume;

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
function status(code: number, statusText: string, body: string): FakeResponse {
  return { ok: false, status: code, statusText, headers: { get: () => null }, json: async () => JSON.parse(body), text: async () => body };
}

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

test('inferMaxLogRangeFromError parses Alchemy free-tier range hints', () => {
  const msg =
    'RPC HTTP 400 Bad Request: Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x2dead68, 0x2dead71].';
  assert.equal(inferMaxLogRangeFromError(new Error(msg)), 10);
  // Falls back to the suggested [start, end] span when the "up to a N" phrasing is absent.
  assert.equal(inferMaxLogRangeFromError(new Error('should work: [0x64, 0x6d]')), 10);
  assert.equal(inferMaxLogRangeFromError(new Error('generic rate limit, no hint')), null);
});

test('base log-scan order is [infura, chainstack, public base.org, alchemy]; polygon has no public endpoint', () => {
  const base = getLogScanRpcUrlsForChain('base');
  assert.ok(base[0].includes('infura.io'), `infura first: ${base[0]}`);
  assert.ok(base.some((u: string) => u.includes('chainstack')), 'chainstack present for base');
  const baseOrgIdx = base.findIndex((u: string) => u.includes('mainnet.base.org'));
  const alchemyIdx = base.findIndex((u: string) => u.includes('alchemy.com'));
  assert.ok(baseOrgIdx !== -1, 'public base.org present in base log-scan');
  assert.ok(alchemyIdx === base.length - 1, `alchemy last: ${base[base.length - 1]}`);
  assert.ok(baseOrgIdx < alchemyIdx, 'public base.org comes before the Alchemy 10-block last-resort');

  assert.deepEqual(getPublicRpcUrlsForChain('base'), ['https://mainnet.base.org']);
  assert.deepEqual(getPublicRpcUrlsForChain('polygon'), [], 'no unverified public endpoint feeds polygon');
  assert.ok(!getLogScanRpcUrlsForChain('polygon').some((u: string) => u.includes('base.org')));
});

test('polygon scan recovers via 10-block Alchemy shrink when Infura 429s (no public endpoint)', async () => {
  const pair = `0x${'d'.repeat(40)}`;
  const usdc = `0x${'c'.repeat(40)}`;
  const alchemyRanges: number[] = [];
  const providersHit = new Set<string>();
  const transferLog = { transactionHash: `0x${'1'.repeat(64)}`, logIndex: '0x0', data: '0x0f4240' };

  globalThis.fetch = (async (url: string | URL, opts?: { body?: string }) => {
    const host = String(url);
    const body = JSON.parse(String((opts && opts.body) || '{}'));
    const provider = host.includes('alchemy.com') ? 'alchemy' : host.includes('infura.io') ? 'infura' : 'other';
    providersHit.add(provider);

    if (provider === 'infura') return status(429, 'Too Many Requests', '{"code":-32005,"message":"Too Many Requests"}');

    // Alchemy core RPC: enforce the free-tier 10-block eth_getLogs cap.
    const p = body.params && body.params[0];
    const from = parseInt(p.fromBlock, 16);
    const to = parseInt(p.toBlock, 16);
    const span = to - from + 1;
    if (span > 10) {
      return status(400, 'Bad Request', `{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [${p.fromBlock}, 0x${(from + 9).toString(16)}]."}}`);
    }
    alchemyRanges.push(span);
    const hit = from <= 100 && 100 <= to;
    return ok({ jsonrpc: '2.0', id: 1, result: hit ? [transferLog] : [] });
  }) as unknown as typeof fetch;

  const total = await sumTokenTransfersViaRpc(100, 124, pair, usdc, 'polygon', 6);

  assert.equal(total, 1, 'summed the single 1.0 transfer after recovering via Alchemy');
  assert.ok(providersHit.has('alchemy'), 'Alchemy core RPC was used for the scan');
  assert.ok(alchemyRanges.every((s) => s <= 10), `every successful Alchemy call stayed within 10 blocks: ${JSON.stringify(alchemyRanges)}`);
});

test('base scan rescues via public base.org (large range) before the Alchemy 10-block grind', async () => {
  const pair = `0x${'d'.repeat(40)}`;
  const usdc = `0x${'c'.repeat(40)}`;
  const providersHit = new Set<string>();
  const baseOrgRanges: number[] = [];
  const transferLog = { transactionHash: `0x${'2'.repeat(64)}`, logIndex: '0x0', data: '0x0f4240' };

  globalThis.fetch = (async (url: string | URL, opts?: { body?: string }) => {
    const host = String(url);
    const body = JSON.parse(String((opts && opts.body) || '{}'));
    const provider = host.includes('alchemy.com')
      ? 'alchemy'
      : host.includes('infura.io')
        ? 'infura'
        : host.includes('chainstack')
          ? 'chainstack'
          : host.includes('mainnet.base.org')
            ? 'base.org'
            : 'other';
    providersHit.add(provider);

    if (provider === 'infura') return status(429, 'Too Many Requests', '{"code":-32005,"message":"Too Many Requests"}');
    if (provider === 'chainstack') return status(403, 'Forbidden', '{"error":{"code":-32002,"message":"Archive not on plan"}}');
    if (provider === 'alchemy') return status(429, 'Too Many Requests', '{"error":{"code":429,"message":"rate limited"}}');

    // base.org: Coinbase's node serves the full 200-block chunk (no 10-block cap).
    const p = body.params && body.params[0];
    const from = parseInt(p.fromBlock, 16);
    const to = parseInt(p.toBlock, 16);
    baseOrgRanges.push(to - from + 1);
    const hit = from <= 100 && 100 <= to;
    return ok({ jsonrpc: '2.0', id: 1, result: hit ? [transferLog] : [] });
  }) as unknown as typeof fetch;

  // 200-block range on base: base.org should serve it in one chunk after
  // infura(429)/chainstack(403), without falling to the Alchemy 10-block path.
  const total = await sumTokenTransfersViaRpc(100, 299, pair, usdc, 'base', 6);

  assert.equal(total, 1, 'summed the transfer via base.org');
  assert.ok(providersHit.has('base.org'), 'public base.org served the scan');
  assert.ok(baseOrgRanges.some((s) => s > 10), `base.org served a >10-block range (no free-tier grind): ${JSON.stringify(baseOrgRanges)}`);
});
