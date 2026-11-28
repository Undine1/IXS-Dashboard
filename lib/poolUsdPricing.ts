import { executeMulticall3, type Multicall3Result } from './multicall3';
import { poolReserveReadKey, type PrefetchedOnchainReads } from './onchainReadKeys';
import type { PoolConfig, PoolUsdQuote } from './poolsConfig';
import type { TaggedMulticall3Call } from './rpcReadBatch';
import { decodeAbiWords } from './v4Liquidity';

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

function quoteReads(pool: PoolConfig): TaggedMulticall3Call[] {
  if (!pool.usdQuote) return [];
  return [
    { target: pool.usdQuote.feed, callData: '0xfeaf968c' },
    { target: pool.usdQuote.feed, callData: '0x313ce567' },
    { target: MULTICALL3, callData: '0x3408e470' },
    { target: MULTICALL3, callData: '0x0f28c97d' },
  ].map((call) => ({
    ...call,
    key: `quote:${pool.network}:${call.target.toLowerCase()}:${call.callData}`,
    allowFailure: true,
  }));
}

// Shared by hourly snapshots and live fallback. Add oracle subcalls to the
// existing per-chain batch; do not make extra HTTP requests on the healthy path.
export function getPoolReadRequests(pool: PoolConfig): TaggedMulticall3Call[] {
  return [
    { key: poolReserveReadKey(pool.network, pool.address), target: pool.address, callData: '0x0902f1ac', allowFailure: true },
    ...quoteReads(pool),
  ];
}

export function decodePoolQuoteUsd(results: Multicall3Result[], quote: PoolUsdQuote, nowMs = Date.now()): number {
  if (results.length !== 4 || results.some((result) => !result.success)) throw new Error('USD quote read failed');
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = decodeAbiWords(results[0].returnData, 5);
  const [decimals] = decodeAbiWords(results[1].returnData, 1);
  const [chainId] = decodeAbiWords(results[2].returnData, 1);
  const [timestamp] = decodeAbiWords(results[3].returnData, 1);
  const now = BigInt(Math.floor(nowMs / 1000));
  if (chainId !== BigInt(quote.chainId)) throw new Error('Wrong USD quote chain');
  if (timestamp > now + BigInt(60) || timestamp < now - BigInt(600)) throw new Error('Stale USD quote chain head');
  if (roundId === BigInt(0) || answeredInRound < roundId || answer <= BigInt(0) || answer >= BigInt(2) ** BigInt(255) ||
      decimals !== BigInt(quote.decimals) || startedAt <= BigInt(0) || startedAt > updatedAt ||
      updatedAt <= BigInt(0) || updatedAt > timestamp || timestamp - updatedAt > BigInt(quote.maxAgeSeconds)) {
    throw new Error('Invalid or stale USD quote');
  }
  const usd = Number(answer) / 10 ** quote.decimals;
  if (!Number.isFinite(usd) || usd <= 0) throw new Error('Invalid USD quote value');
  return usd;
}

export async function readPoolQuoteUsd(pool: PoolConfig, prefetchedReads?: PrefetchedOnchainReads): Promise<number | null> {
  if (!pool.usdQuote) return null;
  const calls = quoteReads(pool);
  const saved = calls.map((call) => prefetchedReads?.get(call.key));
  // A recorded failure in the scheduled snapshot must retain last-known-good
  // data instead of silently manufacturing a quote or repeatedly retrying it.
  if (saved.some((value) => value === null)) throw new Error('USD quote read failed');
  const results = saved.every((value) => typeof value === 'string')
    ? saved.map((returnData) => ({ success: true, returnData: returnData as string }))
    // If a live batch was missing/failed, re-read the whole oracle group in one
    // aggregate so its round, decimals, chain and timestamp share a block.
    : await executeMulticall3(pool.network, calls);
  return decodePoolQuoteUsd(results, pool.usdQuote);
}
