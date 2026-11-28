import type { ChainNetwork, Pool } from '@/types';

export type PoolMeta = {
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
};

export type PoolUsdQuote = {
  token: string;
  feed: string;
  decimals: number;
  chainId: number;
  maxAgeSeconds: number;
};

// V2 pairs only: never send getReserves/token0/token1 to a v4 pool ID.
export type PoolConfig = Omit<Pool, 'value' | 'network'> & {
  network: ChainNetwork;
  priceSource?: boolean;
  usdQuote?: PoolUsdQuote;
  tokenContract?: string;
  // Immutable pair metadata. When present, the pools route skips the
  // token0/token1/decimals eth_calls (constant for a V2 pair) and only reads
  // live reserves. `scripts/verify_pool_meta.ts` validates these against chain.
  meta?: PoolMeta;
};

// RWA pools use the network's IXS price, derived from a stable-paired pool
// or an oracle-priced quote token (e.g. WPOL). lib/poolsService.ts
// processes those price-yielding pools first regardless of order here, so the
// order of this array is presentational only (it drives the UI listing).
// Every network that has dependent pools must keep at least one
// oracle/stable-paired pool, or use the explicit migration-price fallback.

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
    name: 'WIXS-WPOL',
    address: '0xf87b839077db0e5ea5bf8b6460c8413abe72bc2b',
    network: 'polygon',
    explorerUrl: 'https://dexscreener.com/polygon/0xf87b839077db0e5ea5bf8b6460c8413abe72bc2b',
    usdQuote: {
      token: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
      // Chainlink's legacy MATIC/USD proxy now quotes POL (docs.baseAsset=POL).
      // https://reference-data-directory.vercel.app/feeds-matic-mainnet.json
      feed: '0xab594600376ec9fd91f8e885dadf0ce036862de0',
      decimals: 8,
      chainId: 137,
      // Published heartbeat: 27s. Allow delivery jitter, reject prices >2m old.
      maxAgeSeconds: 120,
    },
    meta: {
      // Verified together at Polygon block 0x5d8be36 on 2026-11-28.
      token0: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
      token1: '0x1ba17c639bdaecd8dc4aac37df062d17ee43a1b8',
      decimals0: 18,
      decimals1: 18,
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
