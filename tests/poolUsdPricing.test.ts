import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POOLS } from '../lib/poolsConfig';
import { decodePoolQuoteUsd, getPoolReadRequests, readPoolQuoteUsd } from '../lib/poolUsdPricing';
import { polygonQuoteResults } from './fixtures/polygonQuote';
import { abiWords } from './fixtures/robinhood';
import { isCurrentPoolsSnapshot } from '../lib/poolsService';
import { ROBINHOOD_POOL } from '../lib/robinhoodConfig';
import { ethereumPoolFixture } from './fixtures/ethereum';

const pool = POOLS.find((item) => item.name === 'WIXS-WPOL')!;
const now = Date.parse('2026-11-28T10:00:00Z');
const timestamp = now / 1000;

test('WPOL/USD decodes feed precision and rejects invalid, stale or wrong-chain data', () => {
  assert.ok(pool.usdQuote);
  assert.equal(decodePoolQuoteUsd(polygonQuoteResults(timestamp), pool.usdQuote, now), 0.1);
  for (const [index, raw] of [
    [0, abiWords(0, 10_000_000, timestamp, timestamp, 0)],
    [0, abiWords(100, 0, timestamp, timestamp, 100)],
    [0, abiWords(100, 2n ** 256n - 1n, timestamp, timestamp, 100)],
    [0, abiWords(100, 10_000_000, timestamp, timestamp, 99)],
    [0, abiWords(100, 10_000_000, timestamp - 121, timestamp - 121, 100)],
    [0, abiWords(100, 10_000_000, timestamp, timestamp + 1, 100)],
    [0, abiWords(100, 10_000_000, timestamp + 1, timestamp, 100)],
    [0, '0x'], [1, abiWords(18)], [2, abiWords(1)],
    [3, abiWords(timestamp - 601)], [3, abiWords(timestamp + 61)],
  ] as const) {
    const results = polygonQuoteResults(timestamp);
    results[index].returnData = raw;
    assert.throws(() => decodePoolQuoteUsd(results, pool.usdQuote!, now));
  }
  const failed = polygonQuoteResults(timestamp);
  failed[0].success = false;
  assert.throws(() => decodePoolQuoteUsd(failed, pool.usdQuote!, now));
});

test('recorded snapshot oracle failure cannot trigger retries or fabricate a dollar peg', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error('Unexpected network request'); }) as typeof fetch;
  try {
    const reads = new Map<string, string | null>();
    for (const call of getPoolReadRequests(pool).slice(1)) reads.set(call.key, null);
    await assert.rejects(readPoolQuoteUsd(pool, reads), /USD quote read failed/);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('TVL replaces the old Polygon pool exactly once and rejects stale or duplicated snapshots', () => {
  const pools = [{ ...ROBINHOOD_POOL, value: 100 }, ethereumPoolFixture(), ...POOLS.map((item) => ({ ...item, value: 10 }))];
  const replacementIndex = pools.findIndex((item) => item.address === pool.address);
  assert.equal(pools.filter((item) => item.address === pool.address).length, 1);
  assert.equal(pools.some((item) => item.address === '0xd093a031df30f186976a1e2936b16d95ca7919d6'), false);
  assert.equal(isCurrentPoolsSnapshot({ pools }), true);
  const stale = pools.map((item, index) => index === replacementIndex ? { ...item, name: 'WIXS-USDC', address: '0xd093a031df30f186976a1e2936b16d95ca7919d6' } : item);
  assert.equal(isCurrentPoolsSnapshot({ pools: stale }), false);
  assert.equal(isCurrentPoolsSnapshot({ pools: [...pools, pools[replacementIndex]] }), false);
});
