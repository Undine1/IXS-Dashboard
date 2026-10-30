import type { Pool } from '../types';

export const ETHEREUM_IXS = {
  chainId: 1,
  token: '0x73d7c860998ca3c01ce8c808f5577d94d545d1b4',
  weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  v2Pair: '0xc09bf2b1bc8725903c509e8caeef9190857215a8',
  poolId: '0xd54a5e98dc3d0a90a058d4e46b2db9e7d92dbf50598833035e1f27eac4f23a4f',
  poolManager: '0x000000000004444c5dc75cb358380d2e3de08a90',
  reservesLens: '0x0000001b173c3bbf3984d417d8614e3eed34865b',
  // Initialize event in tx 0x47fcfb22dd9bd87a1ee916eee1fdbccd87aa9959e00b65b815660cb0dc7ddc4b.
  fee: 7000,
  tickSpacing: 50,
  hook: `0x${'0'.repeat(40)}`,
  ethUsdFeed: '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419',
  ethUsdHeartbeatSeconds: 3600,
} as const;

// One display/aggregate row, identified by the v4 ID. Underlying values are
// provenance only; neither constituent is also emitted as a top-level row.
export const ETHEREUM_IXS_POOL: Pool = {
  type: 'Crypto', name: 'IXS/ETH', network: 'ethereum',
  address: ETHEREUM_IXS.poolId,
  tokenContract: ETHEREUM_IXS.token,
  poolManager: ETHEREUM_IXS.poolManager,
  protocol: 'uniswap-v2+v4',
  explorerUrl: `https://dexscreener.com/ethereum/${ETHEREUM_IXS.token}`,
};
