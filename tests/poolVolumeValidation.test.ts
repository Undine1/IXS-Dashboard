import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { poolLogFixture } from './poolVolumeFixtures';

process.env.ALCHEMY_API_KEY = 'pool-test-key';
process.env.BACKUP_INFURA_API_KEY = 'pool-infura-key';
process.env.BACKUP_CHAINSTACK_BASE_RPC_URL = '';
process.env.RPC_MIN_INTERVAL_MS = '0';
process.env.RPC_LOG_BLOCK_CHUNK = '10';
process.env.RPC_MIN_LOG_BLOCK_CHUNK = '10';
process.env.API_MAX_ATTEMPTS = '2';
process.env.API_BASE_DELAY_MS = '1';
process.env.API_MAX_DELAY_MS = '1';
const requireCjs = createRequire(import.meta.url);
const poolVolume = requireCjs('../scripts/update_pool_volume_indexer.js');
const { validateRpcEnvelope, validateRpcMethodResult, sumTokenTransfersViaRpc,
  sumTokenTransfersViaAlchemyAssetTransfers, rpcCallWithUrls, providerCooldowns, setRunDeadline,
  classifyRpcErrorMessage, shouldDisableProviderForRun, refreshPoolWithAnchor } = poolVolume;
const originalFetch = globalThis.fetch;
const pair = `0x${'a'.repeat(40)}`;
const token = `0x${'b'.repeat(40)}`;
const topic = `0x${'0'.repeat(24)}${pair.slice(2)}`;
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const filter = { fromBlock: '0x64', toBlock: '0x6d', address: token, topics: [transferTopic, topic] };
const goodLog = () => poolLogFixture({ transactionHash: `0x${'1'.repeat(64)}`, logIndex: '0x0', data: '0x01' }, filter);
const goodTransfer = () => ({ uniqueId: 'transfer-1', hash: `0x${'1'.repeat(64)}`, blockNum: '0x64',
  from: pair, to: token, category: 'erc20', rawContract: { address: token, value: '0x01' } });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const success = (result: unknown) => response({ jsonrpc: '2.0', id: 1, result });

afterEach(() => {
  globalThis.fetch = originalFetch;
  providerCooldowns.clear();
  setRunDeadline();
});

test('strict JSON-RPC envelopes reject missing results, wrong ids, ambiguous and malformed errors', () => {
  for (const body of [null, {}, { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 2, result: [] },
    { jsonrpc: '1.0', id: 1, result: [] }, { jsonrpc: '2.0', id: 1, result: [], error: {} },
    { jsonrpc: '2.0', id: 1, error: { message: 'oops' } }]) {
    assert.throws(() => validateRpcEnvelope(body, 1), /JSON-RPC/);
  }
});

test('null RPC and Asset Transfers results never advance a scan checkpoint', async () => {
  globalThis.fetch = (async () => success(null)) as typeof fetch;
  let commits = 0;
  const progress = () => { commits += 1; };
  await assert.rejects(() => sumTokenTransfersViaRpc(100, 109, pair, token, 'polygon', 6, progress), /array/);
  await assert.rejects(() => sumTokenTransfersViaAlchemyAssetTransfers(100, 109, pair, token, 'polygon', 6, progress), /Invalid Asset Transfers page/);
  assert.equal(commits, 0);
});

test('invalid log responses fail over to a valid provider for the identical filter', async () => {
  const requested: unknown[] = [];
  globalThis.fetch = (async (url, options) => {
    requested.push(JSON.parse(String(options?.body)).params);
    return success(String(url).includes('bad') ? null : [goodLog()]);
  }) as typeof fetch;
  const logs = await rpcCallWithUrls('polygon', 'eth_getLogs', [filter], ['https://bad.example/rpc', 'https://good.example/rpc']);
  assert.equal(logs.length, 1);
  assert.deepEqual(requested, [[filter], [filter]]);
});

test('malformed, wrong-filter, removed and duplicate transfer logs are rejected', () => {
  for (const logs of [null, [null], [{ ...goodLog(), data: '0x1' }], [{ ...goodLog(), blockNumber: '0x63' }],
    [{ ...goodLog(), address: pair }], [{ ...goodLog(), removed: true }],
    [{ ...goodLog(), transactionHash: undefined }], [goodLog(), goodLog()]]) {
    assert.throws(() => validateRpcMethodResult('eth_getLogs', [filter], logs), /array|Malformed|filter|Duplicate/);
  }
});

test('malformed transfer identities, raw values and wrong contract/range fail validation', () => {
  const params = [{ fromBlock: '0x64', toBlock: '0x6d', fromAddress: pair, contractAddresses: [token] }];
  for (const transfer of [{ ...goodTransfer(), uniqueId: undefined },
    { ...goodTransfer(), rawContract: { address: token, value: 'invalid' } },
    { ...goodTransfer(), rawContract: { address: pair, value: '0x01' } },
    { ...goodTransfer(), blockNum: '0x70' }, { ...goodTransfer(), category: 'external' }]) {
    assert.throws(() => validateRpcMethodResult('alchemy_getAssetTransfers', params, { transfers: [transfer] }), /identity|Malformed|filter/);
  }
});

test('repeated pagination cursors abort before any Asset Transfers checkpoint', async () => {
  let calls = 0;
  let commits = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return success({ transfers: [], pageKey: 'repeated' });
  }) as typeof fetch;
  await assert.rejects(() => sumTokenTransfersViaAlchemyAssetTransfers(100, 109, pair, token, 'polygon', 6,
    () => { commits += 1; }), /Repeated.*cursor/);
  assert.equal(calls, 2);
  assert.equal(commits, 0);
});

test('duplicate events on different pages abort before counting the range', async () => {
  let calls = 0;
  let commits = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return success({ transfers: [goodTransfer()], pageKey: calls === 1 ? 'second' : null });
  }) as typeof fetch;
  await assert.rejects(() => sumTokenTransfersViaAlchemyAssetTransfers(100, 109, pair, token, 'polygon', 6,
    () => { commits += 1; }), /Duplicate event across/);
  assert.equal(commits, 0);
});

test('self transfers returned by both directions are counted once', async () => {
  globalThis.fetch = (async () => success({ transfers: [{ ...goodTransfer(), to: pair }] })) as typeof fetch;
  let rawTotal = 0n;
  await sumTokenTransfersViaAlchemyAssetTransfers(100, 109, pair, token, 'polygon', 6,
    (_block: number, raw: bigint) => { rawTotal += raw; });
  assert.equal(rawTotal, 1n);
});

test('exhausted 5xx providers are skipped while a healthy provider serves identical chunk results', async () => {
  let failedRequests = 0;
  let successfulRequests = 0;
  globalThis.fetch = (async (url, options) => {
    if (String(url).includes('infura')) {
      failedRequests += 1;
      return response({ error: 'unavailable' }, 500);
    }
    successfulRequests += 1;
    const requestFilter = JSON.parse(String(options?.body)).params[0];
    return success([poolLogFixture({ transactionHash: `0x${BigInt(requestFilter.fromBlock).toString(16).padStart(64, '0')}`,
      logIndex: '0x0', data: '0x01' }, requestFilter)]);
  }) as typeof fetch;
  const total = await sumTokenTransfersViaRpc(100, 129, pair, token, 'polygon', 6);
  assert.equal(total, 3 / 1e6);
  assert.equal(failedRequests, 2, 'one exhausted retry budget, instead of repeating it six times');
  assert.equal(successfulRequests, 6);
});

test('a cooling provider remains a recovery option if the healthy provider fails', async () => {
  const urls = ['https://cooling.example/rpc', 'https://healthy.example/rpc'];
  let recovered = false;
  globalThis.fetch = (async (url) => {
    const cooling = String(url).includes('cooling');
    return cooling === recovered ? success([]) : response({}, 503);
  }) as typeof fetch;
  assert.deepEqual(await rpcCallWithUrls('polygon', 'eth_getLogs', [filter], urls), []);
  recovered = true;
  assert.deepEqual(await rpcCallWithUrls('polygon', 'eth_getLogs', [filter], urls), []);
});

test('generic block-range pressure mentioning block 429 shrinks without disabling the provider', async () => {
  const message = 'block range limit exceeded for blocks 429-500';
  const code = classifyRpcErrorMessage(message);
  assert.equal(code, 'RPC_RANGE_LIMIT');
  assert.equal(shouldDisableProviderForRun({ code, message }), false);
  const previous = process.env.RPC_LOG_BLOCK_CHUNK;
  process.env.RPC_LOG_BLOCK_CHUNK = '20';
  globalThis.fetch = (async (_url, options) => {
    const params = JSON.parse(String(options?.body)).params[0];
    return BigInt(params.toBlock) - BigInt(params.fromBlock) + 1n > 10n
      ? response({ error: { code: -32005, message } }, 400) : success([]);
  }) as typeof fetch;
  try {
    assert.equal(await sumTokenTransfersViaRpc(100, 119, pair, token, 'polygon', 6), 0);
  } finally { process.env.RPC_LOG_BLOCK_CHUNK = previous; }
});

test('a range error mentioning block 429 never disables the provider but HTTP 429 still does', () => {
  const message = 'block range limit exceeded for blocks 429-500';
  const code = classifyRpcErrorMessage(message);
  assert.equal(code, 'RPC_RANGE_LIMIT');
  assert.equal(shouldDisableProviderForRun({ code, message }), false);
  assert.equal(shouldDisableProviderForRun({ code, message, status: 400 }), false);
  assert.equal(shouldDisableProviderForRun({ code, message, status: 429 }), true);
  assert.equal(shouldDisableProviderForRun({ code: 'RPC_RANGE_CEILING', message }), false);
});

test('a promotion header failure after a committed RPC window stops without replaying either window', async () => {
  const header = (number: number) => ({ number, timestamp: number * 12,
    hash: `0x${number.toString(16).padStart(64, '0')}` });
  const poolsMap = { [pair]: { total_usd: 1, lastUpdated: 'previous' } };
  const checkpoint: Record<string, { lastBlock: number; lastTimestamp: number; finalized?: { lastBlock: number } }> = {
    [pair]: { lastBlock: 100, lastTimestamp: 1200 },
  };
  const requestedFromBlocks: number[] = [];
  let finalHeaderReads = 0;
  globalThis.fetch = (async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    if (body.method === 'alchemy_getAssetTransfers') {
      return response({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'mock enhanced API unavailable' } });
    }
    const requestFilter = body.params[0];
    requestedFromBlocks.push(Number(BigInt(requestFilter.fromBlock)));
    return success([poolLogFixture({ transactionHash: `0x${BigInt(requestFilter.fromBlock).toString(16).padStart(64, '0')}`,
      logIndex: '0x0', data: '0x01' }, requestFilter)]);
  }) as typeof fetch;
  await assert.rejects(() => refreshPoolWithAnchor({
    poolsMap, checkpoint, addr: pair, legacyCheckpointKey: `${pair}-polygon`, chain: 'polygon',
    pairAddr: pair, usdcAddr: token, decimals: 6, latest: header(121), finalized: header(120),
  }, {
    getBlock: async (_chain: string, number: number) => {
      if (number === 120 && ++finalHeaderReads === 2) {
        throw Object.assign(new Error('mock promotion header timeout'), { code: 'RPC_TIMEOUT' });
      }
      return header(number);
    },
    persist: () => {},
  }), /mock promotion header timeout/);
  assert.deepEqual(requestedFromBlocks, [101, 101, 111, 111]);
  assert.equal(checkpoint[pair].lastBlock, 110);
  assert.equal(checkpoint[pair].finalized?.lastBlock, 110);
  assert.equal(poolsMap[pair].total_usd, 1.000001);
});

test('provider errors and their aggregate metadata never expose keyed URLs', async () => {
  const url = 'https://failure.example/v2/pool-test-key';
  globalThis.fetch = (async () => response({ error: `rejected ${url} credential pool-test-key` }, 400)) as typeof fetch;
  await assert.rejects(() => rpcCallWithUrls('polygon', 'eth_getLogs', [filter], [url]), (error: unknown) => {
    const serialized = String(error) + JSON.stringify(error);
    assert.ok(!serialized.includes('pool-test-key'));
    assert.ok(!serialized.includes('/v2/'));
    return true;
  });
});
