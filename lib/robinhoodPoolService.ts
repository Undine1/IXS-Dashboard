import type { Pool } from '../types';
import { executeMulticall3WithRpcUrls, type Multicall3Result } from './multicall3';
import { getRobinhoodRpcUrls, rpcCall } from './rpc';
import { ROBINHOOD, ROBINHOOD_POOL } from './robinhoodConfig';

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const word = (value: string | number) =>
  (typeof value === 'number' ? value.toString(16) : value.replace(/^0x/, '')).padStart(64, '0');

// getPoolTVL(address,(address,address,uint24,int24,address)). ReservesLens
// reconstructs ALL initialized ranges, not just the active virtual reserves.
export const ROBINHOOD_TVL_CALL = `0xf95138f2${[
  ROBINHOOD.poolManager, ZERO_ADDRESS, ROBINHOOD.token,
  ROBINHOOD.fee, ROBINHOOD.tickSpacing, ROBINHOOD.hook,
].map(word).join('')}`;

function words(raw: string, count: number): bigint[] {
  if (!new RegExp(`^0x[0-9a-f]{${count * 64}}$`, 'i').test(raw)) {
    throw new Error('Malformed Robinhood contract response');
  }
  return Array.from({ length: count }, (_, i) => BigInt(`0x${raw.slice(2 + i * 64, 66 + i * 64)}`));
}

export function decodeRobinhoodLiquidity(results: Multicall3Result[], nowMs = Date.now()) {
  if (results.length !== 5 || results.some((result) => !result.success)) {
    throw new Error('Robinhood contract read failed');
  }
  const lens = words(results[0].returnData, 14);
  const round = words(results[1].returnData, 5);
  const decimals = Number(words(results[2].returnData, 1)[0]);
  const chainId = Number(words(results[3].returnData, 1)[0]);
  const timestamp = Number(words(results[4].returnData, 1)[0]);
  const now = nowMs / 1000;
  if (chainId !== ROBINHOOD.chainId) throw new Error('Wrong Robinhood RPC chain');
  // Robinhood has no Chainlink sequencer uptime feed. Reject stalled/future
  // chain heads instead of treating a frozen state as a fresh valuation.
  if (timestamp > now + 60 || timestamp < now - 600) throw new Error('Stale Robinhood chain head');
  const updatedAt = Number(round[3]);
  if (round[0] === BigInt(0) || round[4] < round[0] || round[1] === BigInt(0) || round[1] >= BigInt(2) ** BigInt(255) ||
      updatedAt <= 0 || updatedAt > timestamp || timestamp - updatedAt > ROBINHOOD.ethUsdHeartbeatSeconds ||
      decimals !== 8) {
    throw new Error('Invalid or stale Robinhood ETH/USD price');
  }
  // Only core principal is counted. Fees and any hook-managed assets are
  // excluded, never added to PoolManager custody. This hook has no return-
  // delta/custom accounting permissions (0x880); fail closed if that changes.
  if (lens[6] === BigInt(0) || lens[6] >= BigInt(2) ** BigInt(160) || lens[11] !== BigInt(0x880) || lens[12] !== BigInt(0)) {
    throw new Error('Unsupported Robinhood pool accounting');
  }
  const ethUsd = Number(round[1]) / 10 ** decimals;
  const ixsPerEth = (Number(lens[6]) / 2 ** 96) ** 2;
  const ethAmount = Number(lens[0]) / 1e18;
  const ixsAmount = Number(lens[1]) / 1e18;
  const ixsUsd = ethUsd / ixsPerEth;
  const value = ethAmount * ethUsd + ixsAmount * ixsUsd;
  if (![ethUsd, ixsUsd, value].every(Number.isFinite) || ethUsd <= 0 || ixsUsd <= 0 || value < 0) {
    throw new Error('Invalid Robinhood pool valuation');
  }
  return { value, ethAmount, ixsAmount, ethUsd, ixsUsd, timestamp };
}

type DexPair = {
  chainId?: string; dexId?: string; pairAddress?: string;
  baseToken?: { address?: string }; quoteToken?: { address?: string };
  volume?: { h24?: unknown };
};

export function parseRobinhoodVolume(payload: { pairs?: DexPair[] | null }): number | null {
  const pairs = payload?.pairs;
  if (!Array.isArray(pairs)) return null;
  const matches = pairs.filter((pair) => pair?.chainId === 'robinhood' && pair.dexId === 'uniswap' &&
    pair.pairAddress?.toLowerCase() === ROBINHOOD.poolId &&
    pair.baseToken?.address?.toLowerCase() === ROBINHOOD.token &&
    pair.quoteToken?.address?.toLowerCase() === ZERO_ADDRESS);
  if (matches.length !== 1) return null;
  const value = matches[0].volume?.h24;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

async function fetchVolume24h(): Promise<number | null> {
  try {
    // One request per snapshot refresh. No retries on 429 and no accumulation
    // of rolling windows into lifetime totals (which would double count).
    const response = await fetch(`https://api.dexscreener.com/latest/dex/pairs/robinhood/${ROBINHOOD.poolId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return parseRobinhoodVolume(await response.json());
  } catch {
    return null;
  }
}

export async function computeRobinhoodPool(): Promise<Pool & { value: number | null }> {
  const urls = getRobinhoodRpcUrls();
  // Pin all five reads to the SAME L2 block, including the USD price. The
  // lens's block.number is an L1 number on Orbit, so don't use it as an RPC tag.
  const block = await rpcCall(urls, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
  if (!/^0x[0-9a-f]+$/i.test(block)) throw new Error('Invalid Robinhood block number');
  const results = await executeMulticall3WithRpcUrls(urls, [
    { target: ROBINHOOD.reservesLens, callData: ROBINHOOD_TVL_CALL, allowFailure: false },
    { target: ROBINHOOD.ethUsdFeed, callData: '0xfeaf968c', allowFailure: false },
    { target: ROBINHOOD.ethUsdFeed, callData: '0x313ce567', allowFailure: false },
    { target: MULTICALL3, callData: '0x3408e470', allowFailure: false },
    { target: MULTICALL3, callData: '0x0f28c97d', allowFailure: false },
  ], block);
  const liquidity = decodeRobinhoodLiquidity(results);
  return {
    ...ROBINHOOD_POOL,
    value: liquidity.value,
    tokenPriceUsd: liquidity.ixsUsd,
    observedAt: new Date(liquidity.timestamp * 1000).toISOString(),
    volume24hUsd: await fetchVolume24h(),
    volumeSource: ROBINHOOD_POOL.explorerUrl,
  };
}
