import type { Pool } from '../types';
import type { Multicall3Result } from './multicall3';
import { getRobinhoodRpcUrls } from './rpc';
import { ROBINHOOD, ROBINHOOD_POOL } from './robinhoodConfig';
import { decodeNativeEthV4Liquidity, encodeNativeEthV4TvlCall, readNativeEthV4Liquidity } from './v4Liquidity';

export const ROBINHOOD_TVL_CALL = encodeNativeEthV4TvlCall(ROBINHOOD);

export function decodeRobinhoodLiquidity(results: Multicall3Result[], nowMs = Date.now()) {
  return decodeNativeEthV4Liquidity(results, ROBINHOOD, nowMs);
}

export async function computeRobinhoodPool(): Promise<Pool & { value: number | null }> {
  const { liquidity } = await readNativeEthV4Liquidity(ROBINHOOD, getRobinhoodRpcUrls());
  return {
    ...ROBINHOOD_POOL,
    value: liquidity.value,
    tokenPriceUsd: liquidity.ixsUsd,
    observedAt: new Date(liquidity.timestamp * 1000).toISOString(),
  };
}
