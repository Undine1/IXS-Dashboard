import type { Pool } from '../types';

export const ROBINHOOD = {
  chainId: 4663,
  token: '0xdcd7face6a1d0bdd0665ea1b0842fc9ce797862b',
  poolId: '0x252827c9712732983d1d720e87ff5f2d875fae840ff128c0331cce0baa6a4bf8',
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  reservesLens: '0x0000001b173c3bbf3984d417d8614e3eed34865b',
  // Verified against Initialize at block 0x5e9401f; keccak256(abi.encode(key))
  // equals poolId. Native ETH sorts before IXS; both use 18 decimals.
  fee: 0x800000, // Dynamic fee flag, not the current swap fee.
  tickSpacing: 50,
  hook: '0xa4e6f5500e88691fdcb289aa0e99067481434880',
  ethUsdFeed: '0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9',
  ethUsdHeartbeatSeconds: 86400,
  migrationDeadline: '2026-12-21T23:59:00Z',
  tokensPerLegacyIxs: 10,
  migrationUrl: 'https://robinhood.ixs.finance/',
} as const;

export const ROBINHOOD_POOL: Pool = {
  type: 'Crypto',
  name: 'IXS-ETH',
  network: 'robinhood',
  address: ROBINHOOD.poolId, // Pool identifier, never an eth_call target.
  tokenContract: ROBINHOOD.token,
  poolManager: ROBINHOOD.poolManager,
  protocol: 'uniswap-v4',
  explorerUrl: `https://dexscreener.com/robinhood/${ROBINHOOD.poolId}`,
  valuation: 'liquidity-principal',
};
