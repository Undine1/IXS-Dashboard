import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRobinhoodLiquidity, parseRobinhoodVolume, computeRobinhoodPool, ROBINHOOD_TVL_CALL } from '../lib/robinhoodPoolService';
import { ROBINHOOD, ROBINHOOD_POOL } from '../lib/robinhoodConfig';
import { isCurrentPoolsSnapshot } from '../lib/poolsService';
import { POOLS } from '../lib/poolsConfig';
import { createSnapshotRpcReadGroups } from '../lib/snapshotRpcBatch';
import { abiWords, robinhoodResults, robinhoodVolumePayload, robinhoodAggregateResponse } from './fixtures/robinhood';

const now = Date.parse('2026-10-30T12:00:00Z');
const timestamp = now / 1000;

test('v4 principal uses both actual reserves and sqrt price, not doubled ETH or legacy token price', () => {
  const result = decodeRobinhoodLiquidity(robinhoodResults(timestamp), now);
  assert.equal(result.ethUsd, 2000);
  assert.equal(result.ixsUsd, 20);
  assert.equal(result.value, 14_000); // 2 ETH + 500 IXS, valued separately
});

test('empty v4 liquidity is zero, not unavailable or phantom PoolManager balances', () => {
  const results = robinhoodResults(timestamp);
  results[0].returnData = results[0].returnData.replace(/^0x.{128}/, abiWords(0, 0));
  assert.equal(decodeRobinhoodLiquidity(results, now).value, 0);
});

test('rejects wrong chain, malformed reads, stalled chain, stale price and incomplete oracle rounds', () => {
  for (const [index, raw] of [
    [3, abiWords(46630)], [4, abiWords(timestamp - 601)], [4, abiWords(timestamp + 61)],
    [1, abiWords(100, 1, 1, timestamp - 86401, 100)], [1, abiWords(100, 0, 1, timestamp, 100)],
    [1, abiWords(100, 2n ** 256n - 1n, 1, timestamp, 100)],
    [1, abiWords(100, 1, 1, timestamp + 1, 100)], [1, abiWords(100, 1, 1, timestamp, 99)],
    [2, abiWords(18)], [0, '0x'],
  ] as const) {
    const results = robinhoodResults(timestamp);
    results[index].returnData = raw;
    assert.throws(() => decodeRobinhoodLiquidity(results, now));
  }
  const failed = robinhoodResults(timestamp);
  failed[0].success = false;
  assert.throws(() => decodeRobinhoodLiquidity(failed, now));
});

test('rejects custom hook accounting and excludes hook reserves from core principal', () => {
  const results = robinhoodResults(timestamp);
  const replaceWord = (index: number, value: bigint) => {
    const raw = results[0].returnData;
    results[0].returnData = raw.slice(0, 2 + index * 64) + abiWords(value).slice(2) + raw.slice(2 + (index + 1) * 64);
  };
  replaceWord(2, 1_000_000n * 10n ** 18n);
  assert.equal(decodeRobinhoodLiquidity(results, now).value, 14_000);
  replaceWord(12, 1n);
  assert.throws(() => decodeRobinhoodLiquidity(results, now), /accounting/);
});

test('24h volume requires one exact pool/token/chain match; missing data is not zero', () => {
  assert.equal(parseRobinhoodVolume(robinhoodVolumePayload()), 250);
  assert.equal(parseRobinhoodVolume(robinhoodVolumePayload(0)), 0);
  for (const value of [null, '250', -1, Infinity]) {
    assert.equal(parseRobinhoodVolume(robinhoodVolumePayload(value)), null);
  }
  const missing = robinhoodVolumePayload();
  missing.pairs[0].volume.h24 = undefined;
  assert.equal(parseRobinhoodVolume(missing), null);
  const duplicate = robinhoodVolumePayload();
  duplicate.pairs.push(duplicate.pairs[0]);
  assert.equal(parseRobinhoodVolume(duplicate), null);
  const wrong = robinhoodVolumePayload();
  wrong.pairs[0].baseToken.address = '0x91d5d2c999c35ce061fd4967e6764cdd9cf1b3e1';
  assert.equal(parseRobinhoodVolume(wrong), null);
  assert.equal(parseRobinhoodVolume({ pairs: null }), null);
});

test('snapshot requires new pool exactly once and keeps all four RWA pools', () => {
  const legacy = POOLS.map((pool) => ({ ...pool, value: 10 }));
  assert.equal(isCurrentPoolsSnapshot({ pools: legacy }), false);
  const pools = [{ ...ROBINHOOD_POOL, value: 14_000 }, ...legacy];
  assert.equal(isCurrentPoolsSnapshot({ pools }), true);
  assert.equal(isCurrentPoolsSnapshot({ pools: [pools[0], pools[0], ...legacy.slice(1)] }), false);
  assert.equal(isCurrentPoolsSnapshot({ pools: [{ ...pools[0], value: null }, ...legacy] }), false);
  assert.equal(pools.filter((pool) => pool.type === 'RWA').length, 4);
  assert.ok(Object.values(createSnapshotRpcReadGroups()).flat().every((call) => call.target.length === 42));
});

test('Robinhood reads are block-pinned and bounded; a volume 429 cannot corrupt TVL', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { method: string; params: unknown[] }[] = [];
  let volumeRequests = 0;
  globalThis.fetch = (async (url, options) => {
    if (String(url).includes('dexscreener')) {
      volumeRequests++;
      return new Response('', { status: 429 });
    }
    const payload = JSON.parse(String(options?.body));
    calls.push(payload);
    return Response.json({ result: payload.method === 'eth_blockNumber' ? '0x123456' : robinhoodAggregateResponse() });
  }) as typeof fetch;
  try {
    const pool = await computeRobinhoodPool();
    assert.equal(pool.value, 14_000);
    assert.equal(pool.volume24hUsd, null);
    assert.equal(volumeRequests, 1);
    assert.deepEqual(calls.map((call) => call.method), ['eth_blockNumber', 'eth_call']);
    assert.equal(calls[1].params[1], '0x123456');
    const call = calls[1].params[0] as { to: string; data: string };
    assert.notEqual(call.to, ROBINHOOD.poolId);
    assert.ok(call.data.includes(ROBINHOOD_TVL_CALL.slice(2)));
  } finally { globalThis.fetch = originalFetch; }
});
