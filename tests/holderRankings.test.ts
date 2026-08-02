import { test } from 'node:test';
import assert from 'node:assert/strict';
import holderRankings from '../scripts/update_holder_rankings.js';

const {
  isValidAddress,
  parseAddressList,
  normalizeTopicAddress,
  getRawBalance,
  applyTransferDelta,
  addThousandsSeparators,
  formatTokenAmount,
  createDefaultState,
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
  rpcCall,
  providerRangeCeilings,
} = holderRankings;

const ZERO = `0x${'0'.repeat(40)}`;
const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const C = `0x${'c'.repeat(40)}`;

// --- helpers for the scan tests (injected fake fetchers, no network/disk) ---
const TOKEN = `0x${'d'.repeat(40)}`;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hex = (v: bigint) => `0x${v.toString(16)}`;
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
    const response = await requestWithRetries('https://rate-limit.example/rpc');
    assert.equal(response.status, 429);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
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
