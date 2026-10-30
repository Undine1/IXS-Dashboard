import { executeMulticall3WithRpcUrls, type Multicall3Call, type Multicall3Result } from './multicall3';
import { rpcCall } from './rpc';

export type NativeEthV4Config = {
  chainId: number;
  token: string;
  poolManager: string;
  reservesLens: string;
  fee: number;
  tickSpacing: number;
  hook: string;
  ethUsdFeed: string;
  ethUsdHeartbeatSeconds: number;
};

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const word = (value: string | number) =>
  (typeof value === 'number' ? value.toString(16) : value.replace(/^0x/, '')).padStart(64, '0');

// getPoolTVL(address,(address,address,uint24,int24,address)). ReservesLens
// reconstructs ALL initialized ranges, not just the active virtual reserves.
export function encodeNativeEthV4TvlCall(config: NativeEthV4Config): string {
  return `0xf95138f2${[
    config.poolManager, ZERO_ADDRESS, config.token,
    config.fee, config.tickSpacing, config.hook,
  ].map(word).join('')}`;
}

export function decodeAbiWords(raw: string, count: number): bigint[] {
  if (!new RegExp(`^0x[0-9a-f]{${count * 64}}$`, 'i').test(raw)) {
    throw new Error('Malformed pool contract response');
  }
  return Array.from({ length: count }, (_, i) => BigInt(`0x${raw.slice(2 + i * 64, 66 + i * 64)}`));
}

export function decodeNativeEthV4Liquidity(results: Multicall3Result[], config: NativeEthV4Config, nowMs = Date.now()) {
  if (results.length !== 5 || results.some((result) => !result.success)) {
    throw new Error('Pool contract read failed');
  }
  const lens = decodeAbiWords(results[0].returnData, 14);
  const round = decodeAbiWords(results[1].returnData, 5);
  const decimals = Number(decodeAbiWords(results[2].returnData, 1)[0]);
  const chainId = Number(decodeAbiWords(results[3].returnData, 1)[0]);
  const timestamp = Number(decodeAbiWords(results[4].returnData, 1)[0]);
  const now = nowMs / 1000;
  if (chainId !== config.chainId) throw new Error('Wrong pool RPC chain');
  // Robinhood has no Chainlink sequencer uptime feed. Reject stalled/future
  // chain heads instead of treating a frozen state as a fresh valuation.
  if (timestamp > now + 60 || timestamp < now - 600) throw new Error('Stale pool chain head');
  const updatedAt = Number(round[3]);
  if (round[0] === BigInt(0) || round[4] < round[0] || round[1] === BigInt(0) || round[1] >= BigInt(2) ** BigInt(255) ||
      updatedAt <= 0 || updatedAt > timestamp || timestamp - updatedAt > config.ethUsdHeartbeatSeconds ||
      decimals !== 8) {
    throw new Error('Invalid or stale ETH/USD price');
  }
  // Only core principal is counted. Fees and any hook-managed assets are
  // excluded, never added to PoolManager custody. Reject custom accounting
  // and require the permissions of this pool's verified, immutable hook.
  const hookPermissions = BigInt(config.hook) & BigInt(0x3fff);
  if (lens[6] === BigInt(0) || lens[6] >= BigInt(2) ** BigInt(160) || lens[11] !== hookPermissions || lens[12] !== BigInt(0)) {
    throw new Error('Unsupported pool accounting');
  }
  const ethUsd = Number(round[1]) / 10 ** decimals;
  const ixsPerEth = (Number(lens[6]) / 2 ** 96) ** 2;
  const ethAmount = Number(lens[0]) / 1e18;
  const ixsAmount = Number(lens[1]) / 1e18;
  const ixsUsd = ethUsd / ixsPerEth;
  const value = ethAmount * ethUsd + ixsAmount * ixsUsd;
  if (![ethUsd, ixsUsd, value].every(Number.isFinite) || ethUsd <= 0 || ixsUsd <= 0 || value < 0) {
    throw new Error('Invalid pool valuation');
  }
  return { value, ethAmount, ixsAmount, ethUsd, ixsUsd, timestamp };
}

export async function readNativeEthV4Liquidity(config: NativeEthV4Config, urls: string[], extraCalls: Multicall3Call[] = []) {
  // Pin all five reads to the SAME L2 block, including the USD price. The
  // lens's block.number is an L1 number on Orbit, so don't use it as an RPC tag.
  const block = await rpcCall(urls, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
  if (!/^0x[0-9a-f]+$/i.test(block)) throw new Error('Invalid pool block number');
  const results = await executeMulticall3WithRpcUrls(urls, [
    { target: config.reservesLens, callData: encodeNativeEthV4TvlCall(config), allowFailure: false },
    { target: config.ethUsdFeed, callData: '0xfeaf968c', allowFailure: false },
    { target: config.ethUsdFeed, callData: '0x313ce567', allowFailure: false },
    { target: MULTICALL3, callData: '0x3408e470', allowFailure: false },
    { target: MULTICALL3, callData: '0x0f28c97d', allowFailure: false },
    ...extraCalls,
  ], block);
  const liquidity = decodeNativeEthV4Liquidity(results.slice(0, 5), config);
  return {
    liquidity,
    extraResults: results.slice(5),
  };
}
