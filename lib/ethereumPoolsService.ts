import type { Pool } from '../types';
import type { Multicall3Result } from './multicall3';
import { getRpcUrls } from './rpc';
import { ETHEREUM_IXS, ETHEREUM_IXS_POOL } from './ethereumPoolsConfig';
import { decodeAbiWords, readNativeEthV4Liquidity } from './v4Liquidity';

export function isEthereumIxsPoolHealthy(pool: Pool): boolean {
  const parts = pool.underlyingPools;
  if (pool.protocol !== 'uniswap-v2+v4' || pool.tokenContract !== ETHEREUM_IXS.token ||
      pool.poolManager !== ETHEREUM_IXS.poolManager || !Array.isArray(parts) || parts.length !== 2) return false;
  const expected = [
    { address: ETHEREUM_IXS.v2Pair, protocol: 'uniswap-v2' },
    { address: ETHEREUM_IXS.poolId, protocol: 'uniswap-v4' },
  ];
  return expected.every((config) => parts.filter((part) => part?.address === config.address &&
    part.protocol === config.protocol && Number.isFinite(part.value) && part.value >= 0).length === 1) &&
    pool.value === parts.reduce((sum, part) => sum + part.value, 0);
}

export function valueEthereumV2(results: Multicall3Result[], ethUsd: number): number {
  if (results.length !== 3 || results.some((result) => !result.success)) throw new Error('Ethereum v2 read failed');
  const [ixs, weth, timestamp] = decodeAbiWords(results[0].returnData, 3);
  if (decodeAbiWords(results[1].returnData, 1)[0] !== BigInt(ETHEREUM_IXS.token) ||
      decodeAbiWords(results[2].returnData, 1)[0] !== BigInt(ETHEREUM_IXS.weth)) {
    throw new Error('Ethereum v2 token mismatch');
  }
  if (ixs >= BigInt(2) ** BigInt(112) || weth >= BigInt(2) ** BigInt(112) || timestamp >= BigInt(2) ** BigInt(32) ||
      !Number.isFinite(ethUsd) || ethUsd <= 0 || ((ixs === BigInt(0)) !== (weth === BigInt(0)))) {
    throw new Error('Invalid Ethereum v2 reserves or price');
  }
  // V2 uses its own reserve-ratio price: each side has the same USD value.
  // This identity is valid for v2, never for the concentrated v4 pool.
  const value = 2 * (Number(weth) / 1e18) * ethUsd;
  if (!Number.isFinite(value)) throw new Error('Invalid Ethereum v2 valuation');
  return value;
}

export async function computeEthereumIxsPool(rpcUrls = getRpcUrls('ethereum')): Promise<Pool & { value: number | null }> {
  const { liquidity, extraResults } = await readNativeEthV4Liquidity(ETHEREUM_IXS, rpcUrls, [
    { target: ETHEREUM_IXS.v2Pair, callData: '0x0902f1ac', allowFailure: false },
    { target: ETHEREUM_IXS.v2Pair, callData: '0x0dfe1681', allowFailure: false },
    { target: ETHEREUM_IXS.v2Pair, callData: '0xd21220a7', allowFailure: false },
  ]);
  const v2Value = valueEthereumV2(extraResults, liquidity.ethUsd);
  return {
    ...ETHEREUM_IXS_POOL,
    value: v2Value + liquidity.value,
    observedAt: new Date(liquidity.timestamp * 1000).toISOString(),
    underlyingPools: [
      { address: ETHEREUM_IXS.v2Pair, protocol: 'uniswap-v2', value: v2Value },
      { address: ETHEREUM_IXS.poolId, protocol: 'uniswap-v4', value: liquidity.value },
    ],
  };
}
