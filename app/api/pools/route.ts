import { NextResponse } from 'next/server';
import axios from 'axios';
import { ChainNetwork, Pool } from '@/types';

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const API_TIMEOUT = 15000;
const WAIT_BETWEEN_POOLS_MS = 600;

type PoolConfig = Omit<Pool, 'value'> & {
  priceSource?: boolean;
  tokenContract?: string;
};

type NetworkPrices = {
  ixs?: { usd: number };
};

type Prices = Partial<Record<ChainNetwork, NetworkPrices>>;

type PoolDebug = {
  token0?: string;
  token1?: string;
  decimals0?: number;
  decimals1?: number;
  reserve0Float?: number;
  reserve1Float?: number;
  price0?: number;
  price1?: number;
  usdValue?: number;
  error?: string;
};

type PoolWithValue = PoolConfig & {
  value: number;
  debug?: PoolDebug;
};

type FetchPoolResult = {
  usdValue: number;
  derivedIxsPrice: number | null;
  debug: PoolDebug;
};

const networkToAlchemy: Record<ChainNetwork, string> = {
  ethereum: 'eth-mainnet',
  polygon: 'polygon-mainnet',
  base: 'base-mainnet',
};

const STABLE_TOKENS_BY_NETWORK: Record<ChainNetwork, string[]> = {
  ethereum: [
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  ],
  polygon: [
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC on Polygon
  ],
  base: [
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC on Base
  ],
};

const IXS_ADDRESS_BY_NETWORK: Record<ChainNetwork, string> = {
  ethereum: (process.env.NEXT_PUBLIC_ETH_TOKEN_ADDRESS || '').toLowerCase(),
  polygon: (process.env.NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS || '').toLowerCase(),
  base: (process.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS || '').toLowerCase(),
};

const POOLS: PoolConfig[] = [
  {
    type: 'Crypto',
    name: 'IXS-USDC',
    address: '0xd22A820DC52F1CAceA7a5c86dA16757F434F43c6',
    network: 'base',
    priceSource: true,
    tokenContract: '0xfe550bffb51eb645ea3b324d772a19ac449e92c5',
  },
  {
    type: 'Crypto',
    name: 'WIXS-USDC',
    address: '0xd093a031df30f186976a1e2936b16d95ca7919d6',
    network: 'polygon',
  },
  {
    type: 'RWA',
    name: 'IXAPE',
    address: '0xfe3d92cf0292a4e44402d1e6a10ae8b575fa61dc',
    network: 'polygon',
  },
  {
    type: 'RWA',
    name: 'TAU',
    address: '0x622efb1fb4a2486b75813aba428639251495eccb',
    network: 'polygon',
  },
  {
    type: 'RWA',
    name: 'MSTO',
    address: '0x05b9cd0ec1fe6bb4e61f4437a56e4aa4b442af5a',
    tokenContract: '0xcbe4c86df7bd5076156a790be70b50f2d3570218',
    network: 'polygon',
  },
  {
    type: 'RWA',
    name: 'CKGP',
    address: '0xec86ceccd8046ed956060988f91c754e7a13328f',
    tokenContract: '0x47d8608e1adb7d600e038ef995ed3951e4b7ded5',
    network: 'polygon',
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientErrorMessage(message: string): boolean {
  return /timeout|ECONNRESET|ENOTFOUND|rate limit|429|throttle/i.test(message);
}

function normalizeAddressFromHex(hexResult: string): string {
  return `0x${hexResult.slice(-40)}`.toLowerCase();
}

function parseHexInt(hexResult: string, label: string): number {
  const parsed = Number.parseInt(hexResult, 16);
  if (Number.isNaN(parsed)) {
    throw new Error(`invalid ${label} result`);
  }
  return parsed;
}

function bigintToDecimalNumber(value: bigint, decimals: number, precision = 12): number {
  if (decimals <= 0) {
    return Number(value);
  }

  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const divisor = BigInt(10) ** BigInt(decimals);
  const integerPart = abs / divisor;
  const fractionalPart = (abs % divisor).toString().padStart(decimals, '0').slice(0, precision);
  const decimalString = `${negative ? '-' : ''}${integerPart.toString()}.${fractionalPart}`;
  const parsed = Number(decimalString);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function alchemyCall(
  alchemyUrl: string,
  payload: Record<string, unknown>,
  maxRetries = 7
): Promise<string> {
  let attempt = 0;
  let delay = 700;

  while (attempt <= maxRetries) {
    try {
      const resp = await axios.post(alchemyUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: API_TIMEOUT,
      });
      const data = resp.data as {
        result?: string;
        error?: { message?: string };
      };

      if (data.error) {
        const errMsg = data.error.message || JSON.stringify(data.error);
        if (isTransientErrorMessage(errMsg) && attempt < maxRetries) {
          await sleep(delay);
          attempt += 1;
          delay *= 2;
          continue;
        }
        throw new Error(errMsg);
      }

      if (!data.result) {
        throw new Error('missing rpc result');
      }

      return data.result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt < maxRetries && isTransientErrorMessage(msg)) {
        await sleep(delay);
        attempt += 1;
        delay *= 2;
        continue;
      }
      throw error;
    }
  }

  throw new Error('alchemyCall: exceeded retries');
}

async function fetchPoolValue(pool: PoolConfig, prices: Prices): Promise<FetchPoolResult> {
  const alchemyNetwork = networkToAlchemy[pool.network];
  const alchemyUrl = `https://${alchemyNetwork}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

  try {
    const token0Hex = await alchemyCall(alchemyUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: pool.address, data: '0x0dfe1681' }, 'latest'],
    });
    const token1Hex = await alchemyCall(alchemyUrl, {
      jsonrpc: '2.0',
      id: 2,
      method: 'eth_call',
      params: [{ to: pool.address, data: '0xd21220a7' }, 'latest'],
    });
    const decimals0Hex = await alchemyCall(alchemyUrl, {
      jsonrpc: '2.0',
      id: 3,
      method: 'eth_call',
      params: [{ to: normalizeAddressFromHex(token0Hex), data: '0x313ce567' }, 'latest'],
    });
    const decimals1Hex = await alchemyCall(alchemyUrl, {
      jsonrpc: '2.0',
      id: 4,
      method: 'eth_call',
      params: [{ to: normalizeAddressFromHex(token1Hex), data: '0x313ce567' }, 'latest'],
    });
    const reservesHex = await alchemyCall(alchemyUrl, {
      jsonrpc: '2.0',
      id: 5,
      method: 'eth_call',
      params: [{ to: pool.address, data: '0x0902f1ac' }, 'latest'],
    });

    if (reservesHex.length < 130) {
      throw new Error('invalid reserves result');
    }

    const token0 = normalizeAddressFromHex(token0Hex);
    const token1 = normalizeAddressFromHex(token1Hex);
    const decimals0 = parseHexInt(decimals0Hex, 'token0 decimals');
    const decimals1 = parseHexInt(decimals1Hex, 'token1 decimals');
    const reserve0 = BigInt(`0x${reservesHex.slice(2, 66)}`);
    const reserve1 = BigInt(`0x${reservesHex.slice(66, 130)}`);

    const reserve0Float = bigintToDecimalNumber(reserve0, decimals0);
    const reserve1Float = bigintToDecimalNumber(reserve1, decimals1);

    const ixsAddress = IXS_ADDRESS_BY_NETWORK[pool.network];
    const stableTokens = STABLE_TOKENS_BY_NETWORK[pool.network] || [];
    const knownIxsUsd = prices[pool.network]?.ixs?.usd || 0;
    const token0Lower = token0.toLowerCase();
    const token1Lower = token1.toLowerCase();

    let price0 = 0;
    if (token0Lower === ixsAddress) {
      price0 = knownIxsUsd;
    } else if (stableTokens.includes(token0Lower)) {
      price0 = 1;
    }

    let price1 = 0;
    if (token1Lower === ixsAddress) {
      price1 = knownIxsUsd;
    } else if (stableTokens.includes(token1Lower)) {
      price1 = 1;
    }

    if (pool.priceSource) {
      if (token0Lower === ixsAddress && price1 === 0) price1 = 1;
      if (token1Lower === ixsAddress && price0 === 0) price0 = 1;
    }

    if (price0 > 0 && price1 === 0 && reserve1Float > 0) {
      price1 = (reserve0Float * price0) / reserve1Float;
    } else if (price1 > 0 && price0 === 0 && reserve0Float > 0) {
      price0 = (reserve1Float * price1) / reserve0Float;
    }

    const usdValue = reserve0Float * price0 + reserve1Float * price1;
    let derivedIxsPrice: number | null = null;
    if (token0Lower === ixsAddress && price0 > 0) derivedIxsPrice = price0;
    if (token1Lower === ixsAddress && price1 > 0) derivedIxsPrice = price1;

    const debug: PoolDebug = {
      token0,
      token1,
      decimals0,
      decimals1,
      reserve0Float,
      reserve1Float,
      price0,
      price1,
      usdValue,
    };

    return { usdValue, derivedIxsPrice, debug };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[pools API] Error fetching ${pool.name} pool value:`, errMsg);
    return { usdValue: 0, derivedIxsPrice: null, debug: { error: errMsg } };
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const debugMode = url.searchParams.get('debug') === '1' || url.searchParams.get('debug') === 'true';

    if (!ALCHEMY_API_KEY) {
      console.warn('[pools API] ALCHEMY_API_KEY not set; eth_calls may fail');
    }

    const prices: Prices = {};
    const warnings: string[] = [];
    const poolsData: PoolWithValue[] = [];
    const poolsDebug: Array<{
      name: string;
      address: string;
      network: ChainNetwork;
      debug: PoolDebug;
      derivedIxsPrice: number | null;
    }> = [];

    for (const pool of POOLS) {
      if (poolsData.length > 0) {
        await sleep(WAIT_BETWEEN_POOLS_MS);
      }

      const result = await fetchPoolValue(pool, prices);
      if (result.derivedIxsPrice && result.derivedIxsPrice > 0) {
        const current = prices[pool.network] || {};
        current.ixs = { usd: result.derivedIxsPrice };
        prices[pool.network] = current;
      }

      if (debugMode) {
        poolsData.push({ ...pool, value: result.usdValue, debug: result.debug });
        poolsDebug.push({
          name: pool.name,
          address: pool.address,
          network: pool.network,
          debug: result.debug,
          derivedIxsPrice: result.derivedIxsPrice,
        });
      } else {
        poolsData.push({ ...pool, value: result.usdValue });
      }
    }

    const body: {
      pools: PoolWithValue[];
      warnings?: string[];
      debug?: {
        prices: Prices;
        pools: typeof poolsDebug;
      };
    } = { pools: poolsData };

    if (warnings.length > 0) body.warnings = warnings;
    if (debugMode) body.debug = { prices, pools: poolsDebug };

    return NextResponse.json(body, {
      status: 200,
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' },
    });
  } catch (error) {
    console.error('[pools API] Unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
