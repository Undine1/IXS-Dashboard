import { test } from 'node:test';
import assert from 'node:assert/strict';
import holderRankings from '../scripts/update_holder_rankings.js';
import holderStateRef from '../scripts/holder_state_ref.js';
import { createCanonicalTransferVerifier } from '../scripts/canonical_transfer_verifier.js';

const {
  isValidAddress,
  parseAddressList,
  normalizeTopicAddress,
  getRawBalance,
  getPendingBalanceReconcile,
  enqueuePendingBalanceReconcile,
  applyTransferDelta,
  addThousandsSeparators,
  formatTokenAmount,
  createDefaultState,
  normalizeState,
  ensureChainState,
  processChainViaAlchemyAssetTransfers,
  processChainViaStandardRpcLogs,
  scanChainRange: processChain,
  processChain: processCanonicalChain,
  verifyHolderPublication,
  requestWithRetries,
  parseRetryAfterMs,
  providerDisableKey,
  shouldDisableProviderForRun,
  disableProviderForRun,
  getDisabledProviderInfo,
  inferMaxLogRangeFromError,
  createFallbackLogBudget,
  parseBalanceOfResult,
  getReconcileBatchSize,
  reconcileFlaggedBalances,
  rpcCall,
  providerRangeCeilings,
  rpcRunUsage,
  validateTransferLogs,
  validateAssetTransfersPage,
  parseRpcEnvelope,
  createHolderRunDeadline,
  providerCooldowns,
} = holderRankings;

const ZERO = `0x${'0'.repeat(40)}`;
const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const C = `0x${'c'.repeat(40)}`;

// --- helpers for the scan tests (injected fake fetchers, no network/disk) ---
const TOKEN = `0x${'d'.repeat(40)}`;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hex = (v: bigint) => `0x${v.toString(16)}`;
const abiWord = (value: number | bigint) => BigInt(value).toString(16).padStart(64, '0');
const pad32 = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`;
let eventSequence = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const xfer = (from: string, to: string, v: bigint, block = 0): any => {
  const hash = `0x${abiWord(++eventSequence)}`;
  return { from, to, blockNum: hex(BigInt(block)), hash, uniqueId: `${hash}:log:0`, category: 'erc20',
    rawContract: { value: hex(v), address: TOKEN } };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const transferLog = (from: string, to: string, v: bigint, block = 0): any => ({
  address: TOKEN,
  topics: [TRANSFER_TOPIC, pad32(from), pad32(to)],
  data: `0x${abiWord(v)}`,
  blockNumber: hex(BigInt(block)), blockHash: `0x${abiWord(block + 1)}`,
  transactionHash: `0x${abiWord(++eventSequence)}`, logIndex: hex(BigInt(eventSequence)), removed: false,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pager = (pages: any[]) => {
  let i = 0;
  return async (_chain: string, _token: string, from: number) => {
    const page = pages[i++] || { transfers: [], pageKey: null };
    return { ...page, transfers: page.transfers.map((transfer: Record<string, unknown>) => ({ ...transfer, blockNum: hex(BigInt(from)) })) };
  };
};
const noPersist = () => {};
const fakeTransferVerifier = () => ({ verifyLogs: async () => {}, verifyAssetTransfers: async () => {} });
const ethConfig = () => ({ chain: 'ethereum', address: TOKEN, decimals: 18 });

test('Retry-After parsing supports seconds, dates, caps, and invalid values', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(parseRetryAfterMs('2', 10_000, now), 2_000);
  assert.equal(parseRetryAfterMs('20', 5_000, now), 5_000);
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:03 GMT', 10_000, now), 3_000);
  assert.equal(parseRetryAfterMs('invalid', 10_000, now), null);
});

test('provider cooldown is scoped to the RPC method', () => {
  const url = 'https://provider.example/rpc';
  assert.notEqual(providerDisableKey(url, 'eth_call'), providerDisableKey(url, 'eth_getLogs'));
  assert.equal(shouldDisableProviderForRun({ status: 429 }), true);
  assert.equal(shouldDisableProviderForRun({ message: 'execution reverted' }), false);

  assert.equal(disableProviderForRun(url, 'eth_call', { code: 'RPC_RATE_LIMIT' }), true);
  assert.ok(getDisabledProviderInfo(url, 'eth_call'));
  assert.equal(getDisabledProviderInfo(url, 'eth_getLogs'), null);
});

test('429 responses use Retry-After and stop after the bounded attempt count', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    API_MAX_ATTEMPTS: process.env.API_MAX_ATTEMPTS,
    API_RATE_LIMIT_MAX_ATTEMPTS: process.env.API_RATE_LIMIT_MAX_ATTEMPTS,
    RPC_MIN_INTERVAL_MS: process.env.RPC_MIN_INTERVAL_MS,
  };
  let calls = 0;

  process.env.API_MAX_ATTEMPTS = '5';
  process.env.API_RATE_LIMIT_MAX_ATTEMPTS = '2';
  process.env.RPC_MIN_INTERVAL_MS = '0';
  rpcRunUsage.reset();
  globalThis.fetch = (async () => {
    calls += 1;
    return {
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: { get: () => '0.001' },
      json: async () => ({}),
      text: async () => 'rate limited',
    };
  }) as unknown as typeof fetch;

  try {
    const response = await requestWithRetries(
      'https://rate-limit.example/rpc',
      {},
      { method: 'eth_getLogs' },
    );
    assert.equal(response.status, 429);
    assert.equal(calls, 2);
    const usage = rpcRunUsage.snapshot();
    assert.equal(usage.requestCount, 2, 'every actual retry attempt is counted');
    assert.equal(usage.providers['rate-limit.example'].methods.eth_getLogs.requestCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    rpcRunUsage.reset();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('range hints are parsed from provider ceiling errors', () => {
  assert.equal(
    inferMaxLogRangeFromError(
      new Error('Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.'),
    ),
    10,
  );
  assert.equal(
    inferMaxLogRangeFromError(new Error('Based on your parameters, this block range should work: [0x64, 0x6d].')),
    10,
  );
  assert.equal(inferMaxLogRangeFromError(new Error('rate limited')), null);
});

function encodeMulticallResults(
  entries: Array<{ success: boolean; returnData: string }>,
): string {
  const tuples = entries.map((entry) => {
    const bytes = entry.returnData.replace(/^0x/, '');
    const padded = bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
    return `${abiWord(entry.success ? 1 : 0)}${abiWord(64)}${abiWord(bytes.length / 2)}${padded}`;
  });
  let nextOffset = entries.length * 32;
  const offsets = tuples.map((tuple) => {
    const offset = abiWord(nextOffset);
    nextOffset += tuple.length / 2;
    return offset;
  });
  return `0x${abiWord(32)}${abiWord(entries.length)}${offsets.join('')}${tuples.join('')}`;
}

test('holder RPC remembers each provider range ceiling without hiding other providers', async () => {
  const constrainedUrl = 'https://range-limited-holder.example/rpc';
  const fallbackUrl = 'https://wide-holder.example/rpc';
  const oversizedParams = [{ fromBlock: '0x64', toBlock: '0x77' }];
  const compliantParams = [{ fromBlock: '0x64', toBlock: '0x6d' }];
  const calls: string[] = [];
  let fallbackShouldFail = false;

  providerRangeCeilings.clear();
  const request = async (url: string, options: { body?: string }) => {
    calls.push(url);
    const body = JSON.parse(String(options.body || '{}'));
    const filter = body.params[0];
    const span = Number.parseInt(filter.toBlock, 16) - Number.parseInt(filter.fromBlock, 16) + 1;

    if (url === constrainedUrl && span > 10) {
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'eth_getLogs requests support up to a 10 block range',
      };
    }
    if (url === fallbackUrl && fallbackShouldFail) {
      return {
        ok: false,
        status: 500,
        statusText: 'Server Error',
        text: async () => 'temporary failure',
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ jsonrpc: '2.0', id: body.id, result: [] }),
    };
  };

  try {
    assert.deepEqual(
      await rpcCall('ethereum', 'eth_getLogs', oversizedParams, {
        urls: [constrainedUrl, fallbackUrl],
        request,
      }),
      [],
    );

    fallbackShouldFail = true;
    await assert.rejects(
      () => rpcCall('ethereum', 'eth_getLogs', oversizedParams, {
        urls: [constrainedUrl, fallbackUrl],
        request,
      }),
      (error: unknown) => error instanceof Error && inferMaxLogRangeFromError(error) === 10,
    );

    assert.deepEqual(
      await rpcCall('ethereum', 'eth_getLogs', compliantParams, {
        urls: [constrainedUrl, fallbackUrl],
        request,
      }),
      [],
    );
    assert.deepEqual(
      calls,
      [constrainedUrl, fallbackUrl, fallbackUrl, constrainedUrl],
      'oversized requests skip only the constrained provider; compliant ranges can use it again',
    );
  } finally {
    providerRangeCeilings.clear();
  }
});

test('holder RPC does not cache a query-specific suggested range as a provider ceiling', async () => {
  const constrainedUrl = 'https://query-specific-holder.example/rpc';
  const fallbackUrl = 'https://query-fallback-holder.example/rpc';
  const params = [{ fromBlock: '0x64', toBlock: '0x77' }];
  let constrainedCalls = 0;

  providerRangeCeilings.clear();
  const request = async (url: string, options: { body?: string }) => {
    if (url === constrainedUrl) {
      constrainedCalls += 1;
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'Based on your parameters, this block range should work: [0x64, 0x6d].',
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ jsonrpc: '2.0', id: JSON.parse(String(options.body)).id, result: [] }),
    };
  };

  try {
    await rpcCall('ethereum', 'eth_getLogs', params, {
      urls: [constrainedUrl, fallbackUrl],
      request,
    });
    await rpcCall('ethereum', 'eth_getLogs', params, {
      urls: [constrainedUrl, fallbackUrl],
      request,
    });
    assert.equal(constrainedCalls, 2, 'the filter-specific suggestion must not suppress later queries');
  } finally {
    providerRangeCeilings.clear();
  }
});

test('holder log scans recover a provider range ceiling when another provider returns malformed data', async () => {
  const urls = ['https://mixed-range-holder.example/rpc', 'https://mixed-invalid-holder.example/rpc'];
  const calls: Array<{ url: string; span: number }> = [];
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 19);
  providerRangeCeilings.clear();
  const request = async (url: string, options: { body: string }) => {
    const envelope = JSON.parse(options.body);
    const filter = envelope.params[0];
    const from = Number(BigInt(filter.fromBlock));
    const span = Number(BigInt(filter.toBlock)) - from + 1;
    calls.push({ url, span });
    return url === urls[0] && span > 10
      ? { ok: false, status: 400, text: async () => 'eth_getLogs requests support up to a 10 block range' }
      : { ok: true, json: async () => ({ jsonrpc: '2.0', id: envelope.id,
        result: url === urls[1] ? null : [transferLog(ZERO, A, 1n, from)] }) };
  };
  try {
    await processChainViaStandardRpcLogs(state, chainState, config, 19, 0, {
      fetchLogs: (chain: string, token: string, from: number, to: number) => rpcCall(chain, 'eth_getLogs', [{
        address: token, fromBlock: hex(BigInt(from)), toBlock: hex(BigInt(to)), topics: [TRANSFER_TOPIC],
      }], { urls, request }),
      persist: noPersist, logBudget: createFallbackLogBudget(10),
    });
    assert.deepEqual(calls, [{ url: urls[0], span: 20 }, { url: urls[1], span: 20 },
      { url: urls[0], span: 10 }, { url: urls[0], span: 10 }]);
    assert.equal(state.holders[A].ethereum, '2');
    assert.equal(chainState.lastScannedBlock, 19);
  } finally {
    providerRangeCeilings.clear();
  }
});

test('range pressure quoting block 429 keeps the holder provider available for an adaptive retry', async () => {
  const originalChunk = process.env.HOLDER_RANKINGS_LOG_CHUNK;
  const originalMinimum = process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK;
  process.env.HOLDER_RANKINGS_LOG_CHUNK = '500';
  process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK = '1';
  try {
    for (const scenario of [
      { name: 'explicit', maximum: 10, latest: 19,
        message: 'eth_getLogs requests support up to a 10 block range; requested blocks include 429',
        spans: [20, 10, 10] },
      { name: 'generic', maximum: 250, latest: 499,
        message: 'block range limit exceeded for blocks 0-499, including block 429',
        spans: [500, 250, 250] },
    ]) {
      providerRangeCeilings.clear();
      const state = createDefaultState();
      const config = ethConfig();
      const chainState = ensureChainState(state, config, scenario.latest);
      const url = `https://holder-${scenario.name}-range.example/rpc`;
      const spans: number[] = [];
      const request = async (_url: string, options: { body: string }) => {
        const envelope = JSON.parse(options.body);
        const filter = envelope.params[0];
        const from = Number(BigInt(filter.fromBlock));
        const span = Number(BigInt(filter.toBlock)) - from + 1;
        spans.push(span);
        return span > scenario.maximum
          ? { ok: false, status: 400, statusText: 'Bad Request', text: async () => scenario.message }
          : { ok: true, json: async () => ({ jsonrpc: '2.0', id: envelope.id,
            result: [transferLog(ZERO, A, 1n, from)] }) };
      };
      await processChainViaStandardRpcLogs(state, chainState, config, scenario.latest, 0, {
        fetchLogs: (chain: string, token: string, from: number, to: number) => rpcCall(chain, 'eth_getLogs', [{
          address: token, fromBlock: hex(BigInt(from)), toBlock: hex(BigInt(to)), topics: [TRANSFER_TOPIC],
        }], { urls: [url], request }),
        persist: noPersist, logBudget: createFallbackLogBudget(10),
      });
      assert.deepEqual(spans, scenario.spans);
      assert.equal(getDisabledProviderInfo(url, 'eth_getLogs'), null);
      assert.equal(state.holders[A].ethereum, '2');
      assert.equal(chainState.lastScannedBlock, scenario.latest);
    }
    for (const code of ['RPC_RANGE_CEILING', 'RPC_RANGE_LIMIT']) {
      assert.equal(shouldDisableProviderForRun({ code, message: 'range pressure at block 429' }), false);
      for (const status of [401, 403, 429]) {
        assert.equal(shouldDisableProviderForRun({ code, status, message: 'range pressure at block 429' }), true);
      }
    }
    assert.equal(shouldDisableProviderForRun({ message: 'rate limit exceeded while scanning block range 429-500' }), true);
    assert.equal(shouldDisableProviderForRun({ code: 'RPC_UNAUTHORIZED', message: 'block range 429-500' }), true);
  } finally {
    providerRangeCeilings.clear();
    if (originalChunk === undefined) delete process.env.HOLDER_RANKINGS_LOG_CHUNK;
    else process.env.HOLDER_RANKINGS_LOG_CHUNK = originalChunk;
    if (originalMinimum === undefined) delete process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK;
    else process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK = originalMinimum;
  }
});

test('standard log fallback follows an explicit range hint below the configured floor', async () => {
  const originalChunk = process.env.HOLDER_RANKINGS_LOG_CHUNK;
  const originalMinChunk = process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK;
  process.env.HOLDER_RANKINGS_LOG_CHUNK = '20000';
  process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK = '500';

  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 30);
  const spans: number[] = [];
  let first = true;

  try {
    await processChainViaStandardRpcLogs(state, chainState, config, 30, 0, {
      fetchLogs: async (_chain: string, _token: string, from: number, to: number) => {
        spans.push(to - from + 1);
        if (first) {
          first = false;
          throw new Error('you can make eth_getLogs requests with up to a 10 block range');
        }
        return [];
      },
      persist: noPersist,
      logBudget: createFallbackLogBudget(20),
    });

    assert.deepEqual(spans, [31, 10, 10, 10, 1]);
  } finally {
    if (originalChunk === undefined) delete process.env.HOLDER_RANKINGS_LOG_CHUNK;
    else process.env.HOLDER_RANKINGS_LOG_CHUNK = originalChunk;
    if (originalMinChunk === undefined) delete process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK;
    else process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK = originalMinChunk;
  }
});

test('standard log fallback stops cleanly at the shared window budget', async () => {
  const originalChunk = process.env.HOLDER_RANKINGS_LOG_CHUNK;
  const originalMinChunk = process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK;
  const originalSaveEvery = process.env.HOLDER_RANKINGS_SAVE_EVERY_BATCHES;
  process.env.HOLDER_RANKINGS_LOG_CHUNK = '10';
  process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK = '10';
  process.env.HOLDER_RANKINGS_SAVE_EVERY_BATCHES = '1';

  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 99);
  const persistedBlocks: number[] = [];
  let first = true;

  try {
    await assert.rejects(
      () => processChainViaStandardRpcLogs(state, chainState, config, 99, 0, {
        fetchLogs: async () => {
          if (first) {
            first = false;
            throw new Error('you can make eth_getLogs requests with up to a 10 block range');
          }
          return [];
        },
        persist: () => persistedBlocks.push(chainState.lastScannedBlock),
        logBudget: createFallbackLogBudget(2),
      }),
      /budget exhausted after 2 windows/,
    );
    assert.equal(chainState.lastScannedBlock, 9);
    assert.deepEqual(persistedBlocks, [9]);
  } finally {
    if (originalChunk === undefined) delete process.env.HOLDER_RANKINGS_LOG_CHUNK;
    else process.env.HOLDER_RANKINGS_LOG_CHUNK = originalChunk;
    if (originalMinChunk === undefined) delete process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK;
    else process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK = originalMinChunk;
    if (originalSaveEvery === undefined) delete process.env.HOLDER_RANKINGS_SAVE_EVERY_BATCHES;
    else process.env.HOLDER_RANKINGS_SAVE_EVERY_BATCHES = originalSaveEvery;
  }
});

test('standard log persistence failure stops before an overlapping retry and replays once next run', async () => {
  const originalChunk = process.env.HOLDER_RANKINGS_LOG_CHUNK;
  const originalMinChunk = process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK;
  const originalSaveEvery = process.env.HOLDER_RANKINGS_SAVE_EVERY_BATCHES;
  process.env.HOLDER_RANKINGS_LOG_CHUNK = '1000';
  process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK = '500';
  process.env.HOLDER_RANKINGS_SAVE_EVERY_BATCHES = '1';

  const config = ethConfig();
  const state = createDefaultState();
  ensureChainState(state, config, 999);
  const durableBefore = JSON.parse(JSON.stringify(state));
  let durableState = JSON.parse(JSON.stringify(durableBefore));
  let fetchCalls = 0;
  let persistCalls = 0;

  const fetchLogs = async () => {
    fetchCalls += 1;
    return [transferLog(ZERO, A, 1n)];
  };

  try {
    await assert.rejects(
      () => processChainViaStandardRpcLogs(
        state,
        state.chains.ethereum,
        config,
        999,
        0,
        {
          fetchLogs,
          persist: (candidate: unknown) => {
            persistCalls += 1;
            if (persistCalls === 1) {
              throw Object.assign(new Error('transient state write failure'), { code: 'EIO' });
            }
            durableState = JSON.parse(JSON.stringify(candidate));
          },
          logBudget: createFallbackLogBudget(10),
        },
      ),
      (error: unknown) => error instanceof Error &&
        (error as Error & { code?: string }).code === 'HOLDER_STATE_PERSIST_FAILED',
    );

    assert.equal(fetchCalls, 1, 'the failed window must not be fetched again in the same run');
    assert.equal(persistCalls, 1, 'the run must terminate at the failed durable write');
    assert.deepEqual(durableState, durableBefore, 'no failed in-memory progress becomes durable');

    const resumedState = JSON.parse(JSON.stringify(durableState));
    const resumedChainState = ensureChainState(resumedState, config, 999);
    await processChainViaStandardRpcLogs(resumedState, resumedChainState, config, 999, 0, {
      fetchLogs: async () => [transferLog(ZERO, A, 1n)],
      persist: (candidate: unknown) => {
        durableState = JSON.parse(JSON.stringify(candidate));
      },
      logBudget: createFallbackLogBudget(10),
    });

    assert.equal(durableState.holders[A].ethereum, '1');
    assert.equal(durableState.chains.ethereum.processedLogCount, 1);
    assert.equal(durableState.chains.ethereum.lastScannedBlock, 999);
  } finally {
    if (originalChunk === undefined) delete process.env.HOLDER_RANKINGS_LOG_CHUNK;
    else process.env.HOLDER_RANKINGS_LOG_CHUNK = originalChunk;
    if (originalMinChunk === undefined) delete process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK;
    else process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK = originalMinChunk;
    if (originalSaveEvery === undefined) delete process.env.HOLDER_RANKINGS_SAVE_EVERY_BATCHES;
    else process.env.HOLDER_RANKINGS_SAVE_EVERY_BATCHES = originalSaveEvery;
  }
});

test('asset-transfers persistence failures are classified as terminal holder-state errors', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 200);
  let fetchCalls = 0;
  let persistCalls = 0;

  await assert.rejects(
    () => processChainViaAlchemyAssetTransfers(state, chainState, config, 200, 0, {
      fetchPage: async () => {
        fetchCalls += 1;
        return { transfers: [xfer(ZERO, A, 1n)], pageKey: null };
      },
      persist: () => {
        persistCalls += 1;
        throw new Error('transient state write failure');
      },
    }),
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === 'HOLDER_STATE_PERSIST_FAILED',
  );

  assert.equal(fetchCalls, 1);
  assert.equal(persistCalls, 1);
});

test('processChain never converts an Alchemy state-write failure into log fallback', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  let fallbackFetchCalls = 0;
  let rollbackPersistCalls = 0;

  await assert.rejects(
    () => processChain(state, config, {
      getLatestBlock: async () => 200,
      getAlchemyRpcUrl: () => 'https://alchemy.example/rpc',
      persist: () => {
        rollbackPersistCalls += 1;
      },
      alchemyScan: {
        fetchPage: async () => ({
          transfers: [xfer(ZERO, A, 1n)],
          pageKey: null,
        }),
        persist: () => {
          throw new Error('transient state write failure');
        },
      },
      standardScan: {
        fetchLogs: async () => {
          fallbackFetchCalls += 1;
          return [];
        },
        persist: noPersist,
        logBudget: createFallbackLogBudget(10),
      },
    }),
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === 'HOLDER_STATE_PERSIST_FAILED',
  );

  assert.equal(fallbackFetchCalls, 0, 'filesystem errors must never trigger standard-log fallback');
  assert.equal(rollbackPersistCalls, 0, 'the terminal error must bypass fallback rollback persistence');
});

test('isValidAddress accepts 20-byte hex and rejects others', () => {
  assert.equal(isValidAddress(A), true);
  assert.equal(isValidAddress('0x123'), false);
  assert.equal(isValidAddress(''), false);
});

test('parseAddressList lowercases, splits, and drops invalid entries', () => {
  const input = `${A.toUpperCase()}, not-an-address\n${B}`;
  assert.deepEqual(parseAddressList(input), [A, B]);
});

test('normalizeTopicAddress extracts the address from a 32-byte topic', () => {
  const topic = `0x${'0'.repeat(24)}${'a'.repeat(40)}`;
  assert.equal(normalizeTopicAddress(topic), A);
  assert.equal(normalizeTopicAddress('0xshort'), '');
});

test('getRawBalance coerces strings/bigints and defaults to 0n', () => {
  assert.equal(getRawBalance('1000'), 1000n);
  assert.equal(getRawBalance(5n), 5n);
  assert.equal(getRawBalance(''), 0n);
  assert.equal(getRawBalance('not-a-number'), 0n);
});

test('applyTransferDelta tracks running balances across mint and transfers', () => {
  const state = createDefaultState();

  // mint 1000 to A (from zero address is ignored)
  applyTransferDelta(state, 'ethereum', ZERO, A, 1000n);
  assert.equal(state.holders[A].ethereum, '1000');

  // A -> B 400
  applyTransferDelta(state, 'ethereum', A, B, 400n);
  assert.equal(state.holders[A].ethereum, '600');
  assert.equal(state.holders[B].ethereum, '400');

  // A -> B 600 drains A entirely (holder entry removed)
  applyTransferDelta(state, 'ethereum', A, B, 600n);
  assert.equal(state.holders[A], undefined);
  assert.equal(state.holders[B].ethereum, '1000');
});

test('applyTransferDelta clamps (not throws) when a balance would go negative', () => {
  // IXS is not a vanilla ERC-20 (balanceOf is changed by non-Transfer
  // mechanics), so event sums can legitimately go negative for high-volume
  // addresses. Instead of failing the run, the sender is clamped to 0 (and
  // flagged for on-chain balanceOf reconciliation), while the recipient is
  // still credited.
  const state = createDefaultState();
  assert.doesNotThrow(() => applyTransferDelta(state, 'ethereum', C, A, 100n));
  assert.equal(state.holders[C], undefined); // clamped to 0 -> entry removed
  assert.equal(state.holders[A].ethereum, '100'); // recipient still credited
  assert.deepEqual(getPendingBalanceReconcile(state, 'ethereum'), [C]);
  const reloaded = JSON.parse(JSON.stringify(state));
  assert.deepEqual(
    getPendingBalanceReconcile(reloaded, 'ethereum'),
    [C],
    'the reconciliation marker survives a process restart',
  );
});

test('legacy v1 checkpoints are discarded once before state is marked v2', () => {
  const legacy = {
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    chains: {
      ethereum: {
        contractStartBlock: 12,
        lastScannedBlock: 200,
        latestBlockAtRun: 200,
        processedLogCount: 50,
        assetTransfersCursor: { pageKey: 'legacy' },
      },
      base: { contractStartBlock: 34, lastScannedBlock: 100 },
    },
    holders: {
      [A]: { ethereum: '0', base: '25' },
      [B]: { ethereum: '10' },
    },
  };

  const migrated = normalizeState(legacy);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.updatedAt, null);
  assert.deepEqual(migrated.holders, {});
  assert.equal(migrated.chains.ethereum.contractStartBlock, 12);
  assert.equal(migrated.chains.base.contractStartBlock, 34);
  for (const chainState of Object.values(migrated.chains) as Array<Record<string, unknown>>) {
    assert.equal(chainState.lastScannedBlock, undefined);
    assert.equal(chainState.latestBlockAtRun, undefined);
    assert.equal(chainState.processedLogCount, undefined);
    assert.equal(chainState.assetTransfersCursor, undefined);
  }

  const normalizedAgain = normalizeState(JSON.parse(JSON.stringify(migrated)));
  assert.equal(normalizedAgain.version, 2);
  assert.deepEqual(normalizedAgain, migrated, 'v2 state is not repeatedly reset');
});

test('balanceOf accepts exactly one ABI word and rejects coercible malformed values', () => {
  assert.equal(parseBalanceOfResult(`0x${abiWord(123)}`), 123n);
  for (const malformed of ['', null, false, true, '0x', '0x01', `0x${'0'.repeat(66)}`]) {
    assert.throws(() => parseBalanceOfResult(malformed), /invalid balanceOf result/);
  }
});

test('reconciliation batch size cannot become zero', () => {
  assert.equal(getReconcileBatchSize('0.5'), 1);
  assert.equal(getReconcileBatchSize('1.9'), 1);
  assert.equal(getReconcileBatchSize('2.9'), 2);
  assert.equal(getReconcileBatchSize('0'), 100);
  assert.equal(getReconcileBatchSize('NaN'), 100);
});

test('an already-synced next run reconciles queued holders in one exact-block batch', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 200);
  chainState.contractStartBlock = 0;
  chainState.lastScannedBlock = 200;
  enqueuePendingBalanceReconcile(state, 'ethereum', A);
  enqueuePendingBalanceReconcile(state, 'ethereum', B);
  const calls: Array<{ method: string; params: unknown[] }> = [];
  let durableState = JSON.parse(JSON.stringify(state));

  const summary = await processChain(state, config, {
    getLatestBlock: async () => 200,
    getAlchemyRpcUrl: () => null,
    standardScan: {
      fetchLogs: async () => {
        throw new Error('already-synced scan must not fetch logs');
      },
      persist: noPersist,
      logBudget: createFallbackLogBudget(10),
    },
    reconcileRpcCall: async (_chain: string, method: string, params: unknown[]) => {
      calls.push({ method, params });
      return encodeMulticallResults([
        { success: true, returnData: `0x${abiWord(5)}` },
        { success: true, returnData: `0x${abiWord(0)}` },
      ]);
    },
    persist: (candidate: unknown) => {
      durableState = JSON.parse(JSON.stringify(candidate));
    },
  });

  assert.equal(summary.reconciled, 2);
  assert.equal(summary.reconcileFailed, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'eth_call');
  const [request, blockTag] = calls[0].params as [{ to: string; data: string }, string];
  assert.equal(blockTag, '0xc8');
  assert.equal(request.to.toLowerCase(), '0xca11bde05977b3631167028862be2a173976ca11');
  assert.ok(request.data.startsWith('0x82ad56cb'));
  assert.equal(durableState.holders[A].ethereum, '5');
  assert.equal(durableState.holders[B], undefined);
  assert.deepEqual(getPendingBalanceReconcile(durableState, 'ethereum'), []);
});

test('failed and malformed Multicall subcalls use exact-block individual fallback', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 100);
  chainState.lastScannedBlock = 100;
  for (const address of [A, B, C]) enqueuePendingBalanceReconcile(state, 'ethereum', address);
  const calls: Array<{ params: unknown[] }> = [];
  let persisted = 0;

  const result = await reconcileFlaggedBalances(state, config, chainState, {
    rpcCall: async (_chain: string, _method: string, params: unknown[]) => {
      calls.push({ params });
      if (calls.length === 1) {
        return encodeMulticallResults([
          { success: true, returnData: `0x${abiWord(11)}` },
          { success: false, returnData: '0x' },
          { success: true, returnData: '0x' },
        ]);
      }
      const [{ data }] = params as [{ data: string }, string];
      if (data.endsWith(B.slice(2))) return `0x${abiWord(22)}`;
      if (data.endsWith(C.slice(2))) return null;
      throw new Error('unexpected individual lookup');
    },
    persist: () => {
      persisted += 1;
    },
  });

  assert.deepEqual(result, { reconciled: 2, failed: 1 });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ params }) => params[1] === '0x64'));
  assert.equal(state.holders[A].ethereum, '11');
  assert.equal(state.holders[B].ethereum, '22');
  assert.equal(state.holders[C], undefined);
  assert.deepEqual(getPendingBalanceReconcile(state, 'ethereum'), [C]);
  assert.equal(persisted, 1);
});

test('a failed Multicall batch falls back to exact-block individual reads', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 50);
  chainState.lastScannedBlock = 50;
  enqueuePendingBalanceReconcile(state, 'ethereum', A);
  enqueuePendingBalanceReconcile(state, 'ethereum', B);
  let calls = 0;

  const result = await reconcileFlaggedBalances(state, config, chainState, {
    rpcCall: async (_chain: string, _method: string, params: unknown[]) => {
      calls += 1;
      assert.equal(params[1], '0x32');
      if (calls === 1) throw new Error('Multicall unavailable');
      return `0x${abiWord(calls === 2 ? 1 : 2)}`;
    },
    persist: noPersist,
  });

  assert.deepEqual(result, { reconciled: 2, failed: 0 });
  assert.equal(calls, 3);
  assert.equal(state.holders[A].ethereum, '1');
  assert.equal(state.holders[B].ethereum, '2');
  assert.deepEqual(getPendingBalanceReconcile(state, 'ethereum'), []);
});

test('balance reconciliation resolves its block reference from the actual durable checkpoint', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 50);
  chainState.lastScannedBlock = 7;
  enqueuePendingBalanceReconcile(state, 'ethereum', A);
  const blockReference = { blockHash: `0x${abiWord(8)}`, requireCanonical: true };
  await reconcileFlaggedBalances(state, config, chainState, {
    blockReference: async (number: number) => {
      assert.equal(number, 7);
      return blockReference;
    },
    rpcCall: async (_chain: string, _method: string, params: unknown[]) => {
      assert.deepEqual(params[1], blockReference);
      return encodeMulticallResults([{ success: true, returnData: `0x${abiWord(9)}` }]);
    },
    persist: noPersist,
  });
  assert.equal(state.holders[A].ethereum, '9');
});

test('reconciliation persistence failure leaves the durable queue retryable', async () => {
  const config = ethConfig();
  const initial = createDefaultState();
  const chainState = ensureChainState(initial, config, 7);
  chainState.lastScannedBlock = 7;
  enqueuePendingBalanceReconcile(initial, 'ethereum', A);
  let durableState = JSON.parse(JSON.stringify(initial));
  const workingState = JSON.parse(JSON.stringify(durableState));

  await assert.rejects(
    () => reconcileFlaggedBalances(workingState, config, workingState.chains.ethereum, {
      rpcCall: async () => encodeMulticallResults([
        { success: true, returnData: `0x${abiWord(9)}` },
      ]),
      persist: () => {
        throw new Error('transient state write failure');
      },
    }),
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === 'HOLDER_STATE_PERSIST_FAILED',
  );

  assert.deepEqual(getPendingBalanceReconcile(durableState, 'ethereum'), [A]);
  assert.equal(durableState.holders[A], undefined);

  const resumed = JSON.parse(JSON.stringify(durableState));
  await reconcileFlaggedBalances(resumed, config, resumed.chains.ethereum, {
    rpcCall: async () => encodeMulticallResults([
      { success: true, returnData: `0x${abiWord(9)}` },
    ]),
    persist: (candidate: unknown) => {
      durableState = JSON.parse(JSON.stringify(candidate));
    },
  });
  assert.equal(durableState.holders[A].ethereum, '9');
  assert.deepEqual(getPendingBalanceReconcile(durableState, 'ethereum'), []);
});

test('from-scratch scans clear stale reconciliation queues and regenerate observed flags', async () => {
  const config = ethConfig();

  const standardState = createDefaultState();
  const standardChainState = ensureChainState(standardState, config, 10);
  enqueuePendingBalanceReconcile(standardState, 'ethereum', A);
  await processChainViaStandardRpcLogs(standardState, standardChainState, config, 10, 0, {
    fetchLogs: async () => [transferLog(C, B, 1n)],
    persist: noPersist,
    logBudget: createFallbackLogBudget(10),
  });
  assert.deepEqual(getPendingBalanceReconcile(standardState, 'ethereum'), [C]);

  const alchemyState = createDefaultState();
  const alchemyChainState = ensureChainState(alchemyState, config, 10);
  enqueuePendingBalanceReconcile(alchemyState, 'ethereum', A);
  await processChainViaAlchemyAssetTransfers(alchemyState, alchemyChainState, config, 10, 0, {
    fetchPage: async () => ({ transfers: [xfer(C, B, 1n)], pageKey: null }),
    persist: noPersist,
  });
  assert.deepEqual(getPendingBalanceReconcile(alchemyState, 'ethereum'), [C]);
});

test('Alchemy fallback rollback restores the prior durable reconciliation queue', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 101);
  chainState.contractStartBlock = 0;
  chainState.lastScannedBlock = 100;
  enqueuePendingBalanceReconcile(state, 'ethereum', A);
  let page = 0;

  const summary = await processChain(state, config, {
    getLatestBlock: async () => 101,
    getAlchemyRpcUrl: () => 'https://alchemy.example/rpc',
    alchemyScan: {
      fetchPage: async () => {
        page += 1;
        if (page === 1) return { transfers: [xfer(C, B, 1n, 101)], pageKey: 'next' };
        throw new Error('page failed');
      },
      persist: noPersist,
    },
    standardScan: {
      fetchLogs: async () => [],
      persist: noPersist,
      logBudget: createFallbackLogBudget(10),
    },
    reconcileRpcCall: async () => {
      throw new Error('reconciliation unavailable');
    },
    persist: noPersist,
  });

  assert.equal(summary.reconcileFailed, 1);
  assert.deepEqual(getPendingBalanceReconcile(state, 'ethereum'), [A]);
  assert.equal(state.holders[C], undefined);
});

test('addThousandsSeparators groups digits', () => {
  assert.equal(addThousandsSeparators('1234567'), '1,234,567');
  assert.equal(addThousandsSeparators('999'), '999');
});

test('formatTokenAmount scales, rounds, and groups', () => {
  assert.equal(formatTokenAmount(`15${'0'.repeat(17)}`, 18), '1.50'); // 1.5
  assert.equal(formatTokenAmount(`12345${'0'.repeat(18)}`, 18), '12,345.00');
  assert.equal(formatTokenAmount(`1234567${'0'.repeat(15)}`, 18), '1,234.57'); // 1234.567 -> 1234.57
});

// --- scan checkpointing / anti-doubling (the pageKey-resume regression) ---

test('alchemy from-scratch scan clears existing balances and drops a stale cursor (no doubling)', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 200); // no lastScannedBlock => full scan
  state.holders[A] = { ethereum: '100' }; // stale/already-counted balance
  // a leftover Alchemy pageKey cursor from an older version: must be ignored+dropped
  chainState.assetTransfersCursor = { fromBlock: 0, toBlock: 200, pageKey: 'stale-uuid' };

  const fetchPage = pager([{ transfers: [xfer(ZERO, A, 50n)], pageKey: null }]);
  await processChainViaAlchemyAssetTransfers(state, chainState, config, 200, 0, { fetchPage, persist: noPersist });

  assert.equal(state.holders[A].ethereum, '50'); // rebuilt from empty, NOT 150 (would be re-stacking)
  assert.equal(chainState.assetTransfersCursor, undefined); // stale cursor dropped
  assert.equal(chainState.lastScannedBlock, 200); // durable block checkpoint set
});

test('alchemy incremental scan preserves balances and applies only the new range', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 200);
  state.holders[A] = { ethereum: '100' };
  chainState.lastScannedBlock = 100; // resume from 101 — must NOT clear

  const fetchPage = pager([{ transfers: [xfer(A, B, 30n)], pageKey: null }]);
  await processChainViaAlchemyAssetTransfers(state, chainState, config, 200, 0, { fetchPage, persist: noPersist });

  assert.equal(state.holders[A].ethereum, '70');
  assert.equal(state.holders[B].ethereum, '30');
  assert.equal(chainState.lastScannedBlock, 200);
});

test('alchemy scan never persists a pageKey cursor (multi-page pagination stays in memory)', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 200);

  const fetchPage = pager([
    { transfers: [xfer(ZERO, A, 100n)], pageKey: 'p1' },
    { transfers: [xfer(A, B, 10n)], pageKey: null },
  ]);
  await processChainViaAlchemyAssetTransfers(state, chainState, config, 200, 0, { fetchPage, persist: noPersist });

  assert.equal(chainState.assetTransfersCursor, undefined);
  assert.equal(state.holders[A].ethereum, '90');
  assert.equal(state.holders[B].ethereum, '10');
});

test('rpc-logs from-scratch scan clears existing balances (no stacking)', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 200);
  state.holders[A] = { ethereum: '100' }; // stale balance

  const fetchLogs = async () => [transferLog(ZERO, A, 50n)];
  await processChainViaStandardRpcLogs(state, chainState, config, 200, 0, { fetchLogs, persist: noPersist });

  assert.equal(state.holders[A].ethereum, '50'); // NOT 150
  assert.equal(chainState.lastScannedBlock, 200);
});

test('malformed JSON-RPC envelopes and false-empty results cannot become successful scans', async () => {
  const params = [{ address: TOKEN, fromBlock: '0x0', toBlock: '0xa' }];
  for (const payload of [null, [], {}, { jsonrpc: '2.0', id: 7 },
    { jsonrpc: '2.0', id: 8, result: [] }, { jsonrpc: '2.0', id: 7, result: null },
    { jsonrpc: '2.0', id: 7, result: {} }]) {
    assert.throws(() => parseRpcEnvelope(payload, 'eth_getLogs', params, 7), /JSON-RPC|eth_getLogs/);
  }
  assert.deepEqual(parseRpcEnvelope({ jsonrpc: '2.0', id: 7, result: [] }, 'eth_getLogs', params, 7), []);
  for (const page of [null, {}, { transfers: null }, { transfers: [], pageKey: 4 }]) {
    assert.throws(() => validateAssetTransfersPage(page, TOKEN, 0, 10), /Alchemy/);
  }
  const state = createDefaultState();
  const chainState = ensureChainState(state, ethConfig(), 10);
  let persisted = false;
  await assert.rejects(() => processChainViaStandardRpcLogs(state, chainState, ethConfig(), 10, 0, {
    fetchLogs: async () => null,
    persist: () => { persisted = true; },
    logBudget: createFallbackLogBudget(10),
  }), /must be an array/);
  assert.equal(chainState.lastScannedBlock, undefined);
  assert.equal(persisted, false);
});

test('holder RPC falls back on an invalid successful payload before accepting a valid empty result', async () => {
  const calls: string[] = [];
  const urls = ['https://invalid-holder.example/rpc', 'https://valid-holder.example/rpc'];
  const result = await rpcCall('ethereum', 'eth_getLogs', [{ address: TOKEN, fromBlock: '0x0', toBlock: '0xa' }], {
    urls,
    request: async (url: string, options: { body: string }) => {
      calls.push(url);
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: JSON.parse(options.body).id,
        result: url === urls[0] ? null : [] }) };
    },
  });
  assert.deepEqual(result, []);
  assert.deepEqual(calls, urls);
});

test('Transfer log validation rejects removed, foreign, malformed and conflicting events while deduplicating exact repeats', () => {
  const valid = transferLog(ZERO, A, 5n, 5);
  assert.deepEqual(validateTransferLogs([valid, { ...valid }], TOKEN, 0, 10), [valid]);
  for (const log of [{ ...valid, removed: true }, { ...valid, address: A },
    { ...valid, data: '0x5' }, { ...valid, blockNumber: '0xb' },
    { ...valid, logIndex: undefined }, { ...valid, topics: [TRANSFER_TOPIC, '0x1234', pad32(A)] }]) {
    assert.throws(() => validateTransferLogs([log], TOKEN, 0, 10), /Transfer/);
  }
  assert.throws(() => validateTransferLogs([valid, { ...valid, data: `0x${abiWord(6)}` }], TOKEN, 0, 10), /Conflicting duplicate/);
  assert.throws(() => validateTransferLogs([valid, { ...transferLog(ZERO, B, 1n, 5), blockHash: `0x${'f'.repeat(64)}` }], TOKEN, 0, 10), /Conflicting block hashes/);
});

test('block-hash Transfer log requests reject responses from a different block', () => {
  const log = transferLog(ZERO, A, 5n, 5);
  const payload = { jsonrpc: '2.0', id: 7, result: [log] };
  const filter = { address: TOKEN, blockHash: log.blockHash, topics: [TRANSFER_TOPIC] };
  assert.deepEqual(parseRpcEnvelope(payload, 'eth_getLogs', [filter], 7), [log]);
  assert.throws(() => parseRpcEnvelope(payload, 'eth_getLogs',
    [{ ...filter, blockHash: `0x${abiWord(999)}` }], 7), /requested block hash/);
  assert.throws(() => parseRpcEnvelope(payload, 'eth_getLogs',
    [{ ...filter, fromBlock: '0x0' }], 7), /Invalid blockHash/);
});

test('locally conflicting Transfer logs abort without shrinking or persisting the range', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 19);
  const valid = transferLog(ZERO, A, 5n, 5);
  let calls = 0;
  let writes = 0;
  await assert.rejects(() => processChainViaStandardRpcLogs(state, chainState, config, 19, 0, {
    fetchLogs: async () => { calls += 1; return [valid, { ...valid, data: `0x${abiWord(6)}` }]; },
    persist: () => { writes += 1; }, logBudget: createFallbackLogBudget(10),
  }), /Conflicting duplicate/);
  assert.equal(calls, 1);
  assert.equal(writes, 0);
  assert.equal(chainState.lastScannedBlock, undefined);
  assert.deepEqual(state.holders, {});
});

test('Alchemy transfer validation requires complete raw ERC-20 data and the requested contract/range', () => {
  const valid = xfer(ZERO, A, 5n, 5);
  assert.deepEqual(validateAssetTransfersPage({ transfers: [valid] }, TOKEN, 0, 10).transfers, [valid]);
  for (const transfer of [{ ...valid, from: null }, { ...valid, uniqueId: '' },
    { ...valid, blockNum: '0xb' }, { ...valid, category: 'external' },
    { ...valid, rawContract: { value: null, address: TOKEN } },
    { ...valid, rawContract: { value: '0x1', address: B } }]) {
    assert.throws(() => validateAssetTransfersPage({ transfers: [transfer] }, TOKEN, 0, 10), /Alchemy/);
  }
});

test('Alchemy terminal empty page keys preserve the completed window without log fallback', async () => {
  for (const transfers of [[], [xfer(ZERO, A, 100n, 5)]]) {
    const state = createDefaultState();
    const config = ethConfig();
    let pages = 0;
    let fallbackCalls = 0;
    await processChain(state, config, {
      getLatestBlock: async () => 10, getAlchemyRpcUrl: () => true, persist: noPersist,
      alchemyScan: {
        fetchPage: async () => { pages += 1; return { transfers, pageKey: '' }; }, persist: noPersist,
      },
      standardScan: {
        fetchLogs: async () => { fallbackCalls += 1; throw new Error('Unexpected log fallback'); },
        persist: noPersist, logBudget: createFallbackLogBudget(10),
      },
    });
    assert.equal(pages, 1);
    assert.equal(fallbackCalls, 0);
    assert.equal(state.chains.ethereum.lastScannedBlock, 10);
    assert.equal(state.chains.ethereum.processedLogCount, transfers.length);
    assert.equal(state.holders[A]?.ethereum, transfers.length ? '100' : undefined);
  }
  for (const pageKey of [' ', '\n', {}, 0, false]) {
    assert.throws(() => validateAssetTransfersPage({ transfers: [], pageKey }, TOKEN, 0, 10), /Malformed Alchemy page key/);
  }
});

test('duplicate Alchemy events across pages are applied once and repeated page keys cannot checkpoint', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 10);
  const minted = xfer(ZERO, A, 100n);
  await processChainViaAlchemyAssetTransfers(state, chainState, config, 10, 0, {
    fetchPage: pager([{ transfers: [minted], pageKey: 'one' },
      { transfers: [minted, xfer(A, B, 20n)], pageKey: null }]),
    persist: noPersist,
  });
  assert.equal(state.holders[A].ethereum, '80');
  assert.equal(chainState.processedLogCount, 2);

  const state2 = createDefaultState();
  const chainState2 = ensureChainState(state2, config, 10);
  let writes = 0;
  await assert.rejects(() => processChainViaAlchemyAssetTransfers(state2, chainState2, config, 10, 0, {
    fetchPage: pager([{ transfers: [minted], pageKey: 'one' }, { transfers: [minted], pageKey: 'one' }]),
    persist: () => { writes += 1; },
  }), /repeated a cursor/);
  assert.equal(writes, 0);
  assert.equal(chainState2.lastScannedBlock, undefined);
});

test('Alchemy verifies the entire paginated window before applying or persisting any transfer', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 11);
  chainState.lastScannedBlock = 10;
  state.holders[A] = { ethereum: '100' };
  const first = xfer(A, B, 30n, 11);
  const second = xfer(A, C, 20n, 11);
  const blockHash = `0x${abiWord(12)}`;
  const canonicalLogs = [first, second].map((transfer, index) => ({
    ...transferLog(transfer.from, transfer.to, BigInt(transfer.rawContract.value), 11),
    blockHash, transactionHash: transfer.hash, logIndex: hex(BigInt(index)),
  }));
  let writes = 0;
  let evidenceCalls = 0;
  const verifier = () => createCanonicalTransferVerifier({
    getBlockHeader: async () => ({ blockNumber: 11, blockHash }),
    getLogsByHash: async (requestedHash: string, token: string) => {
      evidenceCalls += 1;
      assert.equal(requestedHash, blockHash);
      assert.equal(token, TOKEN);
      assert.deepEqual(state.holders, { [A]: { ethereum: '100' } });
      return canonicalLogs;
    },
  });
  await assert.rejects(() => processChainViaAlchemyAssetTransfers(state, chainState, config, 11, 0, {
    fetchPage: async () => ({ transfers: [first], pageKey: '' }),
    verifyAssetTransfers: verifier().verifyAssetTransfers,
    persist: () => { writes += 1; },
  }), { code: 'RPC_CANONICAL_MISMATCH' });
  assert.equal(writes, 0);
  assert.equal(chainState.lastScannedBlock, 10);
  assert.deepEqual(state.holders, { [A]: { ethereum: '100' } });

  let page = 0;
  await processChainViaAlchemyAssetTransfers(state, chainState, config, 11, 0, {
    fetchPage: async () => {
      assert.deepEqual(state.holders, { [A]: { ethereum: '100' } });
      page += 1;
      return page === 1 ? { transfers: [first], pageKey: 'second' }
        : { transfers: [second], pageKey: '' };
    },
    verifyAssetTransfers: verifier().verifyAssetTransfers,
    persist: () => { writes += 1; },
  });
  assert.equal(evidenceCalls, 2, 'each attempt fetches the reported block once across all pages');
  assert.equal(writes, 1);
  assert.equal(chainState.lastScannedBlock, 11);
  assert.equal(state.holders[A].ethereum, '50');
  assert.equal(state.holders[B].ethereum, '30');
  assert.equal(state.holders[C].ethereum, '20');
});

test('verified Alchemy backfills cap oversized operator windows and checkpoint each bounded range', async () => {
  const previous = process.env.HOLDER_RANKINGS_ASSET_TRANSFERS_BLOCK_WINDOW;
  process.env.HOLDER_RANKINGS_ASSET_TRANSFERS_BLOCK_WINDOW = '1000000';
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 40000);
  const ranges: number[][] = [];
  const checkpoints: number[] = [];
  let verifications = 0;
  try {
    await processChainViaAlchemyAssetTransfers(state, chainState, config, 40000, 0, {
      fetchPage: async (_chain: string, _token: string, from: number, to: number) => {
        ranges.push([from, to]);
        return { transfers: [], pageKey: '' };
      },
      verifyAssetTransfers: async () => { verifications += 1; },
      persist: () => { checkpoints.push(chainState.lastScannedBlock); },
    });
    assert.deepEqual(ranges, [[0, 19999], [20000, 39999], [40000, 40000]]);
    assert.deepEqual(checkpoints, [19999, 39999, 40000]);
    assert.equal(verifications, 3);
  } finally {
    if (previous === undefined) delete process.env.HOLDER_RANKINGS_ASSET_TRANSFERS_BLOCK_WINDOW;
    else process.env.HOLDER_RANKINGS_ASSET_TRANSFERS_BLOCK_WINDOW = previous;
  }
});

test('Alchemy fallback preserves completed windows and rolls back only the incomplete window', async () => {
  const prior = process.env.HOLDER_RANKINGS_ASSET_TRANSFERS_BLOCK_WINDOW;
  process.env.HOLDER_RANKINGS_ASSET_TRANSFERS_BLOCK_WINDOW = '10';
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 29);
  chainState.contractStartBlock = 0;
  const fallbackRanges: number[][] = [];
  let page = 0;
  try {
    await processChain(state, config, {
      getLatestBlock: async () => 29, getAlchemyRpcUrl: () => true, persist: noPersist,
      alchemyScan: {
        fetchPage: async () => {
          page += 1;
          if (page === 1) return { transfers: [xfer(ZERO, A, 100n, 1)], pageKey: null };
          if (page === 2) return { transfers: [xfer(A, B, 10n, 11)], pageKey: 'next' };
          throw new Error('temporary page failure');
        }, persist: noPersist,
      },
      standardScan: {
        fetchLogs: async (_chain: string, _token: string, from: number, to: number) => {
          fallbackRanges.push([from, to]);
          return [transferLog(A, C, 20n, 12)];
        }, persist: noPersist, logBudget: createFallbackLogBudget(10),
      },
    });
    assert.deepEqual(fallbackRanges, [[10, 29]]);
    assert.equal(state.holders[A].ethereum, '80');
    assert.equal(state.holders[B], undefined);
    assert.equal(state.holders[C].ethereum, '20');
    assert.equal(state.chains.ethereum.processedLogCount, 2);
  } finally {
    if (prior === undefined) delete process.env.HOLDER_RANKINGS_ASSET_TRANSFERS_BLOCK_WINDOW;
    else process.env.HOLDER_RANKINGS_ASSET_TRANSFERS_BLOCK_WINDOW = prior;
  }
});

function recoveryFixture() {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 10);
  chainState.lastScannedBlock = 10;
  chainState.contractStartBlock = 0;
  chainState.processedLogCount = 1;
  state.holders[A] = { ethereum: '100' };
  const control = { finalized: 10, latest: 12, fork: 0 };
  const header = (number: number) => ({ blockNumber: number,
    blockHash: `0x${abiWord(number + 1 + (number > 10 ? control.fork * 1000 : 0))}` });
  let durable = JSON.parse(JSON.stringify(state));
  const ranges: number[][] = [];
  const deps = {
    createTransferVerifier: fakeTransferVerifier,
    getBlockHeader: async (_chain: string, tag: string | number) => header(
      tag === 'finalized' ? control.finalized : tag === 'latest' ? control.latest : Number(tag)),
    getAlchemyRpcUrl: () => false,
    persist: (candidate: unknown) => {
      holderStateRef.validateHolderState(JSON.stringify(candidate));
      durable = JSON.parse(JSON.stringify(candidate));
    },
    standardScan: {
      fetchLogs: async (_chain: string, _token: string, from: number, to: number) => {
        ranges.push([from, to]);
        return from <= 11 && to >= 11
          ? [transferLog(A, control.fork ? C : B, control.fork ? 40n : 30n, 11)] : [];
      },
      logBudget: createFallbackLogBudget(100),
    },
  };
  return { state, config, control, deps, ranges, header, durable: () => durable };
}

test('trusted legacy balances seed a finalized baseline and same-height reruns never double count', async () => {
  const fixture = recoveryFixture();
  await processCanonicalChain(fixture.state, fixture.config, fixture.deps);
  assert.equal(fixture.state.holders[A].ethereum, '70');
  assert.equal(fixture.state.holders[B].ethereum, '30');
  assert.equal(fixture.state.chains.ethereum.reorg.anchor.balances[A], '100');
  assert.equal(fixture.state.chains.ethereum.lastScannedBlock, 12);
  await processCanonicalChain(fixture.state, fixture.config, fixture.deps);
  assert.equal(fixture.state.holders[A].ethereum, '70');
  assert.equal(fixture.state.holders[B].ethereum, '30');
  assert.deepEqual(fixture.ranges, [[11, 12], [11, 12]]);
});

test('orphaned finalized Transfer logs cannot publish an anchor and a corrected retry resumes cleanly', async () => {
  const fixture = recoveryFixture();
  fixture.control.finalized = 11;
  const orphan = { ...transferLog(A, B, 30n, 11), blockHash: `0x${abiWord(999)}` };
  let stale = true;
  const deps = { ...fixture.deps, createTransferVerifier: createCanonicalTransferVerifier,
    standardScan: { ...fixture.deps.standardScan,
      fetchLogs: async (_chain: string, _token: string, from: number, to: number) => from <= 11 && to >= 11
        ? [stale ? orphan : { ...transferLog(A, C, 40n, 11), blockHash: fixture.header(11).blockHash }] : [],
    },
  };
  await assert.rejects(() => processCanonicalChain(fixture.state, fixture.config, deps),
    { code: 'RPC_CANONICAL_MISMATCH' });
  assert.equal(fixture.durable().chains.ethereum.lastScannedBlock, 10);
  assert.equal(fixture.durable().chains.ethereum.reorg.anchor.blockNumber, 10);
  assert.deepEqual(fixture.durable().holders, { [A]: { ethereum: '100' } });
  assert.deepEqual(fixture.state.holders, { [A]: { ethereum: '100' } });

  stale = false;
  const resumed = JSON.parse(JSON.stringify(fixture.durable()));
  const summary = await processCanonicalChain(resumed, fixture.config, deps);
  await verifyHolderPublication(resumed, [{ chain: fixture.config.chain, ...summary }], deps);
  assert.equal(resumed.holders[A].ethereum, '60');
  assert.equal(resumed.holders[B], undefined);
  assert.equal(resumed.holders[C].ethereum, '40');
  assert.equal(resumed.chains.ethereum.reorg.anchor.blockHash, fixture.header(11).blockHash);
  await processCanonicalChain(resumed, fixture.config, deps);
  assert.equal(resumed.holders[A].ethereum, '60');
  assert.equal(resumed.holders[C].ethereum, '40');
});

test('canonical Alchemy scans fetch hash-bound evidence before promoting their completed window', async () => {
  const fixture = recoveryFixture();
  fixture.control.finalized = 11;
  fixture.control.latest = 11;
  const transfer = xfer(A, B, 30n, 11);
  const blockHash = fixture.header(11).blockHash;
  let evidenceCalls = 0;
  await processCanonicalChain(fixture.state, fixture.config, {
    ...fixture.deps, createTransferVerifier: createCanonicalTransferVerifier,
    getAlchemyRpcUrl: () => true,
    alchemyScan: { fetchPage: async () => ({ transfers: [transfer], pageKey: '' }) },
    rpcCall: async (_chain: string, method: string, params: unknown[]) => {
      evidenceCalls += 1;
      assert.equal(method, 'eth_getLogs');
      assert.deepEqual(params, [{ blockHash, address: TOKEN, topics: [TRANSFER_TOPIC] }]);
      assert.equal(fixture.state.holders[A].ethereum, '100');
      return [{ ...transferLog(A, B, 30n, 11), blockHash, transactionHash: transfer.hash }];
    },
  });
  assert.equal(evidenceCalls, 1);
  assert.equal(fixture.state.chains.ethereum.reorg.anchor.balances[A], '70');
  assert.equal(fixture.state.chains.ethereum.reorg.anchor.balances[B], '30');
});

test('canonical balance reconciliation keeps Multicall and individual fallbacks pinned to the block hash', async () => {
  const fixture = recoveryFixture();
  fixture.control.finalized = 11;
  const calls: unknown[] = [];
  const deps = { ...fixture.deps, createTransferVerifier: createCanonicalTransferVerifier,
    standardScan: { ...fixture.deps.standardScan,
      fetchLogs: async (_chain: string, _token: string, from: number, to: number) => from <= 11 && to >= 11
        ? [{ ...transferLog(C, B, 10n, 11), blockHash: fixture.header(11).blockHash }] : [],
    },
    reconcileRpcCall: async (_chain: string, method: string, params: unknown[]) => {
      assert.equal(method, 'eth_call');
      calls.push(params[1]);
      if (calls.length === 1) throw new Error('Multicall unavailable');
      return `0x${abiWord(5)}`;
    },
  };
  await processCanonicalChain(fixture.state, fixture.config, deps);
  assert.deepEqual(calls, Array(2).fill({ blockHash: fixture.header(11).blockHash, requireCanonical: true }));
  assert.equal(fixture.state.chains.ethereum.reorg.anchor.balances[C], '5');
  assert.deepEqual(getPendingBalanceReconcile(fixture.state, 'ethereum'), []);
});

test('a reorg between runs replaces the complete unfinalized tail while preserving current-head freshness', async () => {
  const fixture = recoveryFixture();
  await processCanonicalChain(fixture.state, fixture.config, fixture.deps);
  fixture.control.fork = 1;
  await processCanonicalChain(fixture.state, fixture.config, fixture.deps);
  assert.equal(fixture.state.holders[A].ethereum, '60');
  assert.equal(fixture.state.holders[B], undefined);
  assert.equal(fixture.state.holders[C].ethereum, '40');
  assert.equal(fixture.state.chains.ethereum.lastScannedBlock, fixture.control.latest);
});

test('a reorg during a scan cannot publish or retain the inconsistent recent tail', async () => {
  const fixture = recoveryFixture();
  const fetchLogs = fixture.deps.standardScan.fetchLogs;
  fixture.deps.standardScan.fetchLogs = async (...args) => {
    const result = await fetchLogs(...args);
    fixture.control.fork = 1;
    return result;
  };
  await assert.rejects(() => processCanonicalChain(fixture.state, fixture.config, fixture.deps), /checkpoint hash changed/);
  assert.equal(fixture.durable().holders[A].ethereum, '100');
  assert.equal(fixture.durable().holders[B], undefined);
  assert.equal(fixture.durable().chains.ethereum.lastScannedBlock, 10);
  fixture.deps.standardScan.fetchLogs = fetchLogs;
  await processCanonicalChain(fixture.state, fixture.config, fixture.deps);
  assert.equal(fixture.state.holders[A].ethereum, '60');
});

test('finalized advancement promotes the reconciled canonical data without stacking prior tail events', async () => {
  const fixture = recoveryFixture();
  await processCanonicalChain(fixture.state, fixture.config, fixture.deps);
  fixture.control.finalized = 11;
  await processCanonicalChain(fixture.state, fixture.config, fixture.deps);
  assert.equal(fixture.state.chains.ethereum.reorg.anchor.blockNumber, 11);
  assert.equal(fixture.state.chains.ethereum.reorg.anchor.balances[A], '70');
  assert.equal(fixture.state.holders[B].ethereum, '30');
  assert.deepEqual(fixture.ranges, [[11, 12], [11, 11], [12, 12]]);
});

test('legacy checkpoint ahead of finality remains untouched and cannot be falsely refreshed', async () => {
  const fixture = recoveryFixture();
  fixture.control.finalized = 9;
  const before = JSON.parse(JSON.stringify(fixture.state.holders));
  await assert.rejects(() => processCanonicalChain(fixture.state, fixture.config, fixture.deps), /Waiting for.*finality/);
  assert.deepEqual(fixture.state.holders, before);
  assert.equal(fixture.state.chains.ethereum.reorg, undefined);
  assert.deepEqual(fixture.ranges, []);
});

test('a changed canonical baseline fails closed before any transfer requests', async () => {
  const fixture = recoveryFixture();
  await processCanonicalChain(fixture.state, fixture.config, fixture.deps);
  const getHeader = fixture.deps.getBlockHeader;
  fixture.deps.getBlockHeader = async (chain, tag) => {
    const header = await getHeader(chain, tag);
    return tag === 10 ? { ...header, blockHash: `0x${'f'.repeat(64)}` } : header;
  };
  const before = JSON.parse(JSON.stringify(fixture.durable()));
  await assert.rejects(() => processCanonicalChain(fixture.state, fixture.config, fixture.deps), /checkpoint hash changed/);
  assert.deepEqual(fixture.durable(), before);
  assert.deepEqual(fixture.ranges, [[11, 12]]);
});

test('publication rechecks earlier chains after later work and rolls back a newly reorganized tail', async () => {
  const fixture = recoveryFixture();
  const summary = await processCanonicalChain(fixture.state, fixture.config, fixture.deps);
  fixture.control.fork = 1;
  await assert.rejects(() => verifyHolderPublication(fixture.state,
    [{ chain: fixture.config.chain, ...summary }], fixture.deps), /checkpoint hash changed/);
  assert.equal(fixture.durable().holders[A].ethereum, '100');
  assert.equal(fixture.durable().holders[B], undefined);
  assert.equal(fixture.durable().chains.ethereum.lastScannedBlock, 10);
});

test('interrupted finalized backfill resumes completed windows without replaying their balances', async () => {
  const prior = process.env.HOLDER_RANKINGS_ASSET_TRANSFERS_BLOCK_WINDOW;
  process.env.HOLDER_RANKINGS_ASSET_TRANSFERS_BLOCK_WINDOW = '10';
  const fixture = recoveryFixture();
  fixture.control.finalized = 30;
  fixture.control.latest = 30;
  const ranges: number[][] = [];
  let interrupted = false;
  const alchemyDeps = { ...fixture.deps, getAlchemyRpcUrl: () => true,
    alchemyScan: {
      fetchPage: async (_chain: string, _token: string, from: number, to: number) => {
        ranges.push([from, to]);
        if (from === 21 && !interrupted) {
          interrupted = true;
          throw Object.assign(new Error('cooperative test deadline'), { code: 'HOLDER_RUN_BUDGET_EXHAUSTED' });
        }
        return { transfers: [xfer(ZERO, A, 1n, from)], pageKey: null };
      },
    },
  };
  try {
    await assert.rejects(() => processCanonicalChain(fixture.state, fixture.config, alchemyDeps), /cooperative test deadline/);
    const resumed = fixture.durable();
    assert.equal(resumed.chains.ethereum.lastScannedBlock, 20);
    assert.equal(resumed.chains.ethereum.reorg.phase, 'canonical');
    assert.equal(resumed.holders[A].ethereum, '101');
    await processCanonicalChain(resumed, fixture.config, alchemyDeps);
    assert.equal(resumed.holders[A].ethereum, '102');
    assert.deepEqual(ranges, [[11, 20], [21, 30], [21, 30]]);
    assert.equal(resumed.chains.ethereum.reorg.anchor.blockNumber, 30);
  } finally {
    if (prior === undefined) delete process.env.HOLDER_RANKINGS_ASSET_TRANSFERS_BLOCK_WINDOW;
    else process.env.HOLDER_RANKINGS_ASSET_TRANSFERS_BLOCK_WINDOW = prior;
  }
});

test('a changed finalized target during collection cannot promote the new canonical baseline', async () => {
  const fixture = recoveryFixture();
  fixture.control.finalized = 11;
  const fetchLogs = fixture.deps.standardScan.fetchLogs;
  fixture.deps.standardScan.fetchLogs = async (...args) => {
    const result = await fetchLogs(...args);
    fixture.control.fork = 1;
    return result;
  };
  await assert.rejects(() => processCanonicalChain(fixture.state, fixture.config, fixture.deps), /checkpoint hash changed/);
  assert.equal(fixture.durable().chains.ethereum.reorg.anchor.blockNumber, 10);
  assert.equal(fixture.durable().chains.ethereum.reorg.phase, 'canonical');
});

test('failed canonical reconciliation preserves the old anchor and prevents successful publication', async () => {
  const fixture = recoveryFixture();
  fixture.control.finalized = 11;
  fixture.deps.standardScan.fetchLogs = async () => [transferLog(C, B, 10n, 11)];
  await assert.rejects(() => processCanonicalChain(fixture.state, fixture.config, {
    ...fixture.deps, reconcileRpcCall: async () => { throw new Error('fixture RPC unavailable'); },
  }), /remain queued/);
  assert.equal(fixture.durable().chains.ethereum.reorg.anchor.blockNumber, 10);
  assert.deepEqual(fixture.durable().chains.ethereum.pendingBalanceReconcile, [C]);
});

test('run deadlines save completed standard-log progress before exiting at a safe boundary', async () => {
  const priorChunk = process.env.HOLDER_RANKINGS_LOG_CHUNK;
  process.env.HOLDER_RANKINGS_LOG_CHUNK = '500';
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 999);
  let time = 0;
  const checkDeadline = createHolderRunDeadline(10, () => time);
  let durable = JSON.parse(JSON.stringify(state));
  try {
    await assert.rejects(() => processChainViaStandardRpcLogs(state, chainState, config, 999, 0, {
      checkDeadline,
      fetchLogs: async () => { time = 10; return [transferLog(ZERO, A, 1n, 1)]; },
      persist: (candidate: unknown) => { durable = JSON.parse(JSON.stringify(candidate)); },
      logBudget: createFallbackLogBudget(10),
    }), /time budget exhausted/);
    assert.equal(durable.chains.ethereum.lastScannedBlock, 499);
    assert.equal(durable.holders[A].ethereum, '1');
  } finally {
    if (priorChunk === undefined) delete process.env.HOLDER_RANKINGS_LOG_CHUNK;
    else process.env.HOLDER_RANKINGS_LOG_CHUNK = priorChunk;
  }
});

test('exhausted transient provider failures prefer a healthy alternative on later holder calls', async () => {
  providerCooldowns.clear();
  const urls = ['https://unavailable-holder.example/rpc', 'https://healthy-holder.example/rpc'];
  const calls: string[] = [];
  const request = async (url: string, options: { body: string }) => {
    calls.push(url);
    return url === urls[0]
      ? { ok: false, status: 503, text: async () => 'unavailable' }
      : { ok: true, json: async () => ({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result: '0xa' }) };
  };
  try {
    await rpcCall('ethereum', 'eth_blockNumber', [], { urls, request });
    await rpcCall('ethereum', 'eth_blockNumber', [], { urls, request });
    assert.deepEqual(calls, [urls[0], urls[1], urls[1]]);
  } finally {
    providerCooldowns.clear();
  }
});

test('seeded holder history matches an independent balance oracle across restarts, finality advances and tail replacements', async () => {
  const addresses = [A, B, C];
  const initial = { [A]: 1000n, [B]: 1000n, [C]: 1000n };
  type Event = { block: number; index: number; from: string; to: string; amount: bigint };
  let events: Event[] = [];
  const hashes = new Map<number, string>([[0, `0x${abiWord(1)}`]]);
  let generation = 0;

  // This oracle performs plain debits/credits from the trusted seed. It shares
  // no balance application, snapshot, checkpoint or replay code with the updater.
  const oracle = (tip: number) => {
    const balances: Record<string, bigint> = { ...initial };
    for (const event of events) {
      if (event.block > tip) continue;
      if (event.from !== ZERO) balances[event.from] -= event.amount;
      balances[event.to] += event.amount;
    }
    for (const balance of Object.values(balances)) assert.ok(balance >= 0n);
    return Object.fromEntries(Object.entries(balances).filter(([, raw]) => raw > 0n)
      .map(([address, raw]) => [address, raw.toString()]));
  };

  const replaceSuffix = (fromBlock: number, seed: number) => {
    events = events.filter((event) => event.block < fromBlock);
    const startingBalances = oracle(fromBlock - 1);
    const running = Object.fromEntries(addresses.map((address) => [address, BigInt(startingBalances[address] || '0')]));
    let randomState = seed >>> 0;
    const random = () => {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      return randomState >>> 0;
    };
    generation += 1;
    for (let block = fromBlock; block <= 30; block += 1) {
      hashes.set(block, `0x${abiWord(generation * 1000 + block)}`);
      const count = 1 + random() % 3;
      for (let index = 0; index < count; index += 1) {
        const senderIndex = random() % addresses.length;
        const from = block % 7 === 0 ? ZERO : addresses[senderIndex];
        const to = addresses[(senderIndex + 1 + random() % 2) % addresses.length];
        const wanted = BigInt(1 + random() % 40);
        const amount = from === ZERO || running[from] >= wanted ? wanted : running[from];
        if (amount === 0n) continue;
        events.push({ block, index, from, to, amount });
        if (from !== ZERO) running[from] -= amount;
        running[to] = (running[to] || 0n) + amount;
      }
    }
  };

  replaceSuffix(1, 0x1234abcd);
  const config = ethConfig();
  const initialState = createDefaultState();
  const chainState = ensureChainState(initialState, config, 0);
  chainState.lastScannedBlock = 0;
  chainState.contractStartBlock = 0;
  chainState.processedLogCount = 0;
  initialState.holders = Object.fromEntries(Object.entries(initial)
    .map(([address, raw]) => [address, { ethereum: raw.toString() }]));
  let durable = JSON.parse(JSON.stringify(initialState));
  let finalized = 0;
  let latest = 0;
  const deps = {
    createTransferVerifier: createCanonicalTransferVerifier,
    getBlockHeader: async (_chain: string, tag: string | number) => {
      const block = tag === 'finalized' ? finalized : tag === 'latest' ? latest : Number(tag);
      return { blockNumber: block, blockHash: hashes.get(block) };
    },
    getAlchemyRpcUrl: () => false,
    persist: (candidate: unknown) => {
      const serialized = JSON.stringify(candidate);
      holderStateRef.validateHolderState(serialized);
      durable = JSON.parse(serialized);
    },
    standardScan: {
      fetchLogs: async (_chain: string, _token: string, from: number, to: number) => events
        .filter((event) => event.block >= from && event.block <= to)
        .map((event) => ({ ...transferLog(event.from, event.to, event.amount, event.block),
          blockHash: hashes.get(event.block), logIndex: hex(BigInt(event.index)),
          transactionHash: `0x${abiWord(event.block * 10 + event.index + 1)}` })),
      logBudget: createFallbackLogBudget(100),
    },
  };
  const steps = [
    { finalized: 3, latest: 7 },
    { finalized: 5, latest: 10 },
    { finalized: 5, latest: 10, replaceFrom: 6, seed: 0xabc123 },
    { finalized: 8, latest: 14 },
    { finalized: 8, latest: 14, replaceFrom: 9, seed: 0xfeedbeef },
    { finalized: 12, latest: 18 },
    { finalized: 18, latest: 22 },
    { finalized: 18, latest: 22, replaceFrom: 19, seed: 0xdecafbad },
    { finalized: 22, latest: 24 },
  ];
  for (const [stepIndex, step] of steps.entries()) {
    if (step.replaceFrom != null) {
      assert.ok(step.replaceFrom > finalized, 'the model never changes a finalized block');
      replaceSuffix(step.replaceFrom, step.seed!);
    }
    finalized = step.finalized;
    latest = step.latest;
    for (let repeat = 0; repeat < 2; repeat += 1) {
      // Every invocation starts from serialized durable state, including the
      // unchanged repeat after each step, as a new scheduled process would.
      const restarted = JSON.parse(JSON.stringify(durable));
      await processCanonicalChain(restarted, config, deps);
      const actual = Object.fromEntries(Object.entries(restarted.holders)
        .map(([address, balances]) => [address, (balances as Record<string, string>).ethereum]));
      assert.deepEqual(actual, oracle(latest), `full balance oracle at step ${stepIndex}, repeat ${repeat}`);
      assert.deepEqual(restarted.chains.ethereum.reorg.anchor.balances, oracle(finalized),
        `canonical balance oracle at step ${stepIndex}, repeat ${repeat}`);
      assert.equal(restarted.chains.ethereum.lastScannedBlock, latest);
      assert.equal(restarted.chains.ethereum.processedLogCount,
        events.filter((event) => event.block <= latest).length, 'each canonical event is counted exactly once');
    }
  }
});
