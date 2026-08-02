import { test } from 'node:test';
import assert from 'node:assert/strict';

const word = (value: number | bigint) => BigInt(value).toString(16).padStart(64, '0');

function encodeAggregateResults(
  count: number,
  returnData: string,
  failedIndexes = new Set<number>(),
): string {
  const tuples = Array.from({ length: count }, (_, index) => {
    const success = !failedIndexes.has(index);
    const bytes = success ? returnData.replace(/^0x/, '') : '';
    const padded = bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
    return `${word(success ? 1 : 0)}${word(64)}${word(bytes.length / 2)}${padded}`;
  });
  let nextOffset = count * 32;
  const offsets: string[] = [];
  for (const tuple of tuples) {
    offsets.push(word(nextOffset));
    nextOffset += tuple.length / 2;
  }
  return `0x${word(32)}${word(count)}${offsets.join('')}${tuples.join('')}`;
}

function aggregateCallCount(data: string): number {
  const encoded = data.replace(/^0x/, '');
  return Number(BigInt(`0x${encoded.slice(8 + 64, 8 + 128)}`));
}

test('live pool and burn reads batch per chain and retain individual fallback', async () => {
  const originalFetch = globalThis.fetch;
  const envKeys = [
    'ALCHEMY_API_KEY',
    'BACKUP_INFURA_API_KEY',
    'BACKUP_CHAINSTACK_BASE_RPC_URL',
    'NEXT_PUBLIC_ETH_TOKEN_ADDRESS',
    'NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS',
    'NEXT_PUBLIC_BASE_TOKEN_ADDRESS',
    'NEXT_PUBLIC_ETH_BURN_ADDRESSES',
    'NEXT_PUBLIC_POLYGON_BURN_ADDRESSES',
    'NEXT_PUBLIC_BASE_BURN_ADDRESSES',
  ] as const;
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  process.env.ALCHEMY_API_KEY = 'live-batch-test-key';
  process.env.BACKUP_INFURA_API_KEY = '';
  process.env.BACKUP_CHAINSTACK_BASE_RPC_URL = '';
  process.env.NEXT_PUBLIC_ETH_TOKEN_ADDRESS = `0x${'1'.repeat(40)}`;
  process.env.NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS = '0x1ba17c639bdaecd8dc4aac37df062d17ee43a1b8';
  process.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS = '0xfe550bffb51eb645ea3b324d772a19ac449e92c5';
  process.env.NEXT_PUBLIC_ETH_BURN_ADDRESSES = `0x${'2'.repeat(40)}`;
  process.env.NEXT_PUBLIC_POLYGON_BURN_ADDRESSES = `0x${'3'.repeat(40)}`;
  process.env.NEXT_PUBLIC_BASE_BURN_ADDRESSES = `0x${'4'.repeat(40)}`;

  const reserves = `0x${word(1_000_000)}${word(1_000_000_000_000_000_000n)}${word(0)}`;
  const balance = `0x${word(42)}`;
  const requests: string[] = [];
  let phase: 'pools' | 'burns' | 'pool-fallback' | 'pool-subcall-fallback' = 'pools';

  globalThis.fetch = (async (url: string | URL, options?: RequestInit) => {
    const network = new URL(String(url)).host.split('.')[0];
    const body = JSON.parse(String(options?.body || '{}')) as {
      params: Array<{ data: string }>;
    };
    const data = body.params[0].data;
    const isBatch = data.startsWith('0x82ad56cb');
    requests.push(`${phase}:${network}:${isBatch ? 'batch' : data.slice(0, 10)}`);

    if (phase === 'pool-fallback' && network === 'base-mainnet' && isBatch) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'execution reverted' } }),
      };
    }

    const failedIndexes =
      phase === 'pool-subcall-fallback' && network === 'polygon-mainnet'
        ? new Set([0])
        : undefined;
    const result = isBatch
      ? encodeAggregateResults(
          aggregateCallCount(data),
          phase === 'burns' ? balance : reserves,
          failedIndexes,
        )
      : reserves;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ jsonrpc: '2.0', id: 1, result }),
    };
  }) as unknown as typeof fetch;

  try {
    const [{ computePoolsBody }, { computeBurnStats }] = await Promise.all([
      import('../lib/poolsService'),
      import('../lib/burnStatsService'),
    ]);

    const pools = await computePoolsBody();
    assert.equal(pools.healthy, true);
    assert.equal(pools.body.pools.length, 6);
    assert.ok(pools.body.pools.every((pool) => typeof pool.value === 'number'));
    const batchedPoolValues = pools.body.pools.map((pool) => pool.value);
    assert.deepEqual(
      requests.filter((entry) => entry.startsWith('pools:')),
      ['pools:polygon-mainnet:batch', 'pools:base-mainnet:batch'],
    );

    phase = 'burns';
    const burns = await computeBurnStats();
    assert.equal(burns.healthy, true);
    assert.deepEqual(burns.payload, {
      ethereum: { balances: { [`0x${'2'.repeat(40)}`]: '42' } },
      polygon: { balances: { [`0x${'3'.repeat(40)}`]: '42' } },
      base: { balances: { [`0x${'4'.repeat(40)}`]: '42' } },
    });
    assert.deepEqual(
      requests.filter((entry) => entry.startsWith('burns:')),
      [
        'burns:eth-mainnet:batch',
        'burns:polygon-mainnet:batch',
        'burns:base-mainnet:batch',
      ],
    );

    phase = 'pool-fallback';
    const fallbackPools = await computePoolsBody();
    assert.equal(fallbackPools.healthy, true);
    assert.deepEqual(
      fallbackPools.body.pools.map((pool) => pool.value),
      batchedPoolValues,
      'individual fallback preserves the batched valuation result',
    );
    assert.deepEqual(
      requests.filter((entry) => entry.startsWith('pool-fallback:')),
      [
        'pool-fallback:polygon-mainnet:batch',
        'pool-fallback:base-mainnet:batch',
        'pool-fallback:base-mainnet:0x0902f1ac',
      ],
    );

    phase = 'pool-subcall-fallback';
    const subcallFallbackPools = await computePoolsBody();
    assert.equal(subcallFallbackPools.healthy, true);
    assert.deepEqual(
      subcallFallbackPools.body.pools.map((pool) => pool.value),
      batchedPoolValues,
      'one failed subcall falls back without changing valuations',
    );
    assert.deepEqual(
      requests.filter((entry) => entry.startsWith('pool-subcall-fallback:')),
      [
        'pool-subcall-fallback:polygon-mainnet:batch',
        'pool-subcall-fallback:base-mainnet:batch',
        'pool-subcall-fallback:polygon-mainnet:0x0902f1ac',
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
