import { test } from 'node:test';
import assert from 'node:assert/strict';

const word = (value: number | bigint) => BigInt(value).toString(16).padStart(64, '0');

function encodeSuccessfulResults(count: number): string {
  const returnData = `${word(1)}${word(1)}${word(1)}`;
  const tuple = `${word(1)}${word(64)}${word(96)}${returnData}`;
  let nextOffset = count * 32;
  const offsets: string[] = [];
  for (let index = 0; index < count; index += 1) {
    offsets.push(word(nextOffset));
    nextOffset += tuple.length / 2;
  }
  return `0x${word(32)}${word(count)}${offsets.join('')}${tuple.repeat(count)}`;
}

test('hourly snapshot prefetch emits one Multicall3 request per configured chain', async () => {
  const originalFetch = globalThis.fetch;
  const envKeys = [
    'ALCHEMY_API_KEY',
    'NEXT_PUBLIC_ETH_TOKEN_ADDRESS',
    'NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS',
    'NEXT_PUBLIC_BASE_TOKEN_ADDRESS',
    'NEXT_PUBLIC_ETH_BURN_ADDRESSES',
    'NEXT_PUBLIC_POLYGON_BURN_ADDRESSES',
    'NEXT_PUBLIC_BASE_BURN_ADDRESSES',
  ] as const;
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  process.env.ALCHEMY_API_KEY = 'snapshot-test-key';
  process.env.NEXT_PUBLIC_ETH_TOKEN_ADDRESS = `0x${'1'.repeat(40)}`;
  process.env.NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS = `0x${'2'.repeat(40)}`;
  process.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS = `0x${'3'.repeat(40)}`;
  process.env.NEXT_PUBLIC_ETH_BURN_ADDRESSES = [
    `0x${'4'.repeat(40)}`,
    `0x${'5'.repeat(40)}`,
    `0x${'6'.repeat(40)}`,
  ].join(',');
  process.env.NEXT_PUBLIC_POLYGON_BURN_ADDRESSES = `0x${'7'.repeat(40)}`;
  process.env.NEXT_PUBLIC_BASE_BURN_ADDRESSES = `0x${'8'.repeat(40)}`;

  const callsByNetwork = new Map<string, number>();
  globalThis.fetch = (async (url: string | URL, options?: RequestInit) => {
    const host = new URL(String(url)).host;
    const network = host.split('.')[0];
    const body = JSON.parse(String(options?.body || '{}')) as {
      params: Array<{ data: string }>;
    };
    const data = body.params[0].data.slice(2);
    const callCount = Number(BigInt(`0x${data.slice(8 + 64, 8 + 128)}`));
    callsByNetwork.set(network, (callsByNetwork.get(network) || 0) + 1);

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ jsonrpc: '2.0', id: 1, result: encodeSuccessfulResults(callCount) }),
    };
  }) as unknown as typeof fetch;

  try {
    const { prefetchSnapshotRpcReads } = await import('../lib/snapshotRpcBatch');
    const reads = await prefetchSnapshotRpcReads();

    assert.equal(reads.size, 11);
    assert.deepEqual(Object.fromEntries(callsByNetwork), {
      'eth-mainnet': 1,
      'polygon-mainnet': 1,
      'base-mainnet': 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
