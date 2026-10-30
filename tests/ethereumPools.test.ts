import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEthereumIxsPool, isEthereumIxsPoolHealthy, valueEthereumV2 } from '../lib/ethereumPoolsService';
import { ETHEREUM_IXS } from '../lib/ethereumPoolsConfig';
import { decodeNativeEthV4Liquidity } from '../lib/v4Liquidity';
import { abiWords, aggregateResponse } from './fixtures/robinhood';
import { ethereumResults, ethereumPoolFixture } from './fixtures/ethereum';

test('one Ethereum row combines independently priced v2 and v4 pools at the same block', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { method: string; params: unknown[] }[] = [];
  let failedV2 = false;
  globalThis.fetch = (async (url, options) => {
    assert.equal(String(url), 'https://ethereum.test');
    const request = JSON.parse(String(options?.body));
    calls.push(request);
    const results = ethereumResults();
    if (failedV2) results[5].success = false;
    return Response.json({ result: request.method === 'eth_blockNumber' ? '0x123456' : aggregateResponse(results) });
  }) as typeof fetch;
  try {
    const pool = await computeEthereumIxsPool(['https://ethereum.test']);
    assert.equal(pool.name, 'IXS/ETH');
    assert.equal(pool.network, 'ethereum');
    assert.equal(pool.value, 26_000); // v2 12k at its own reserve ratio, v4 14k
    assert.deepEqual(pool.underlyingPools, ethereumPoolFixture().underlyingPools);
    assert.equal(isEthereumIxsPoolHealthy(pool), true);
    assert.equal('volume24hUsd' in pool, false);
    assert.deepEqual(calls.map((call) => call.method), ['eth_blockNumber', 'eth_call']);
    assert.equal(calls[1].params[1], '0x123456');
    const data = (calls[1].params[0] as { data: string }).data;
    assert.ok(data.includes(ETHEREUM_IXS.v2Pair.slice(2)));
    assert.ok(data.includes(ETHEREUM_IXS.poolManager.slice(2)));
    failedV2 = true;
    await assert.rejects(computeEthereumIxsPool(['https://ethereum.test']), /v2 read failed/);
  } finally { globalThis.fetch = originalFetch; }
});

test('Ethereum snapshot refuses duplicate components and totals that count them twice', () => {
  const pool = ethereumPoolFixture();
  assert.equal(isEthereumIxsPoolHealthy(pool), true);
  assert.equal(isEthereumIxsPoolHealthy({ ...pool, value: pool.value * 2 }), false);
  assert.equal(isEthereumIxsPoolHealthy({ ...pool, underlyingPools: [pool.underlyingPools[0], pool.underlyingPools[0]] }), false);
  assert.equal(isEthereumIxsPoolHealthy({ ...pool, underlyingPools: [pool.underlyingPools[0]] }), false);
});

test('v2 requires the correct assets and complete reserves; fully withdrawn liquidity is zero', () => {
  const results = ethereumResults().slice(5);
  assert.equal(valueEthereumV2(results, 2000), 12_000);
  results[0].returnData = abiWords(0, 0, 0);
  assert.equal(valueEthereumV2(results, 2000), 0);
  results[0].returnData = abiWords(1, 0, 0);
  assert.throws(() => valueEthereumV2(results, 2000), /reserves/);
  results[0].returnData = abiWords(1, 1, 0);
  results[1].returnData = abiWords(BigInt(ETHEREUM_IXS.weth));
  assert.throws(() => valueEthereumV2(results, 2000), /token mismatch/);
});

test('Ethereum uses its own chain and one-hour oracle heartbeat, not Robinhood parameters', () => {
  const now = Date.now();
  const timestamp = Math.floor(now / 1000);
  const results = ethereumResults(timestamp).slice(0, 5);
  assert.equal(decodeNativeEthV4Liquidity(results, ETHEREUM_IXS, now).value, 14_000);
  results[1].returnData = abiWords(100, 2000n * 10n ** 8n, 1, timestamp - 3601, 100);
  assert.throws(() => decodeNativeEthV4Liquidity(results, ETHEREUM_IXS, now), /stale/);
});
