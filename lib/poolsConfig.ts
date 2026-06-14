import type { Pool } from '@/types';

export type PoolMeta = {
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
};

export type PoolConfig = Omit<Pool, 'value'> & {
  priceSource?: boolean;
  tokenContract?: string;
  // Immutable pair metadata. When present, the pools route skips the
  // token0/token1/decimals eth_calls (constant for a V2 pair) and only reads
  // live reserves. `scripts/verify_pool_meta.ts` validates these against chain.
  meta?: PoolMeta;
};

// Pricing derivation note: pools paired with a non-stable token (the RWA
// pools) are valued using the network's IXS price, which is derived from a
// priceSource or stable-paired pool on the same network. lib/poolsService.ts
// processes those price-yielding pools first regardless of order here, so the
// order of this array is presentational only (it drives the UI listing).
// Every network that has dependent pools must keep at least one
// priceSource/stable-paired pool, or the dependent pools will value as null.

export const POOLS: PoolConfig[] = [
  {
    type: 'Crypto',
    name: 'IXS-USDC',
    address: '0xd22A820DC52F1CAceA7a5c86dA16757F434F43c6',
    network: 'base',
    priceSource: true,
    tokenContract: '0xfe550bffb51eb645ea3b324d772a19ac449e92c5',
    meta: {
      token0: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      token1: '0xfe550bffb51eb645ea3b324d772a19ac449e92c5',
      decimals0: 6,
      decimals1: 18,
    },
  },
  {
    type: 'Crypto',
    name: 'WIXS-USDC',
    address: '0xd093a031df30f186976a1e2936b16d95ca7919d6',
    network: 'polygon',
    meta: {
      token0: '0x1ba17c639bdaecd8dc4aac37df062d17ee43a1b8',
      token1: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
      decimals0: 18,
      decimals1: 6,
    },
  },
  {
    type: 'RWA',
    name: 'IXAPE',
    address: '0xfe3d92cf0292a4e44402d1e6a10ae8b575fa61dc',
    network: 'polygon',
    meta: {
      token0: '0x1ba17c639bdaecd8dc4aac37df062d17ee43a1b8',
      token1: '0x8fe65d81f5a77732dbcc3878ba93bdeb3e3a8538',
      decimals0: 18,
      decimals1: 18,
    },
  },
  {
    type: 'RWA',
    name: 'TAU',
    address: '0x622efb1fb4a2486b75813aba428639251495eccb',
    network: 'polygon',
    meta: {
      token0: '0x1ba17c639bdaecd8dc4aac37df062d17ee43a1b8',
      token1: '0x940a5cc6f3b6d9bf7a710e7e641369685ccaecad',
      decimals0: 18,
      decimals1: 18,
    },
  },
  {
    type: 'RWA',
    name: 'MSTO',
    address: '0x05b9cd0ec1fe6bb4e61f4437a56e4aa4b442af5a',
    tokenContract: '0xcbe4c86df7bd5076156a790be70b50f2d3570218',
    network: 'polygon',
    meta: {
      token0: '0x1ba17c639bdaecd8dc4aac37df062d17ee43a1b8',
      token1: '0xcbe4c86df7bd5076156a790be70b50f2d3570218',
      decimals0: 18,
      decimals1: 18,
    },
  },
  {
    type: 'RWA',
    name: 'CKGP',
    address: '0xec86ceccd8046ed956060988f91c754e7a13328f',
    tokenContract: '0x47d8608e1adb7d600e038ef995ed3951e4b7ded5',
    network: 'polygon',
    meta: {
      token0: '0x1ba17c639bdaecd8dc4aac37df062d17ee43a1b8',
      token1: '0x47d8608e1adb7d600e038ef995ed3951e4b7ded5',
      decimals0: 18,
      decimals1: 18,
    },
  },
];
