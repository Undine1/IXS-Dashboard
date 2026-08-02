import { test } from 'node:test';
import assert from 'node:assert/strict';
import holderRankings from '../scripts/update_holder_rankings.js';

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
  processChain,
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const xfer = (from: string, to: string, v: bigint): any => ({ from, to, rawContract: { value: hex(v) } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const transferLog = (from: string, to: string, v: bigint): any => ({
  topics: [TRANSFER_TOPIC, pad32(from), pad32(to)],
  data: hex(v),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pager = (pages: any[]) => {
  let i = 0;
  return async () => pages[i++] || { transfers: [], pageKey: null };
};
const noPersist = () => {};
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
      json: async () => ({ jsonrpc: '2.0', id: 1, result: [] }),
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
  const request = async (url: string) => {
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
      json: async () => ({ jsonrpc: '2.0', id: 1, result: [] }),
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
        if (page === 1) return { transfers: [xfer(C, B, 1n)], pageKey: 'next' };
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
