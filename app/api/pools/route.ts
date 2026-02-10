import { NextResponse } from 'next/server';
import axios from 'axios';

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const API_TIMEOUT = 15000;
const WAIT_BETWEEN_POOLS_MS = 600;
// (HTML scraping removed)
// Server-side hourly cache to avoid repeated RPCs from serverless cold starts
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let cachedBody: any = null;
let cachedAt = 0;

// Network to Alchemy network mapping
const networkToAlchemy: Record<string, string> = {
  ethereum: 'eth-mainnet',
  polygon: 'polygon-mainnet',
  base: 'base-mainnet'
};

// Known stable token addresses used to automatically detect price-source pools
// (lowercased). Add addresses here when you add a new chain.
const STABLE_TOKENS_BY_NETWORK: Record<string, string[]> = {
  ethereum: [
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' // USDC
  ],
  polygon: [
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174' // USDC on Polygon
  ],
  // base: [] // Add Base stable token addresses here if desired
};

/*
Example POOLS entry (place price-source pools first):

const POOLS = [
  // Price-source pool that pairs project token with a USD stable token
  {
    type: 'Crypto',
    name: 'IXS-USDC',
    address: '0x...pairAddress...',
    network: 'polygon' as const,
    // optional: priceSource: true
  },
  // Dependent pool that can use derived IXS price
  {
    type: 'RWA',
    name: 'IXAPE',
    address: '0x...pairAddress...',
    network: 'polygon' as const,
  }
];

Ensure price-source pools (those pairing to USDC/USDT) appear before dependent pools.
*/

// No external price provider: derive prices from pools when possible

// Pool configurations (order matters: price-source pools first)
const POOLS = [
  {
    type: 'Crypto',
    name: 'IXS-USDC',
    address: '0xd22A820DC52F1CAceA7a5c86dA16757F434F43c6',
    network: 'base' as const,
    priceSource: true,
    tokenContract: '0xfe550bffb51eb645ea3b324d772a19ac449e92c5',
  },
  {
    type: 'Crypto',
    name: 'WIXS-USDC',
    address: '0xd093a031df30f186976a1e2936b16d95ca7919d6',
    network: 'polygon' as const,
  },
  {
    type: 'RWA',
    name: 'IXAPE',
    address: '0xfe3d92cf0292a4e44402d1e6a10ae8b575fa61dc',
    network: 'polygon' as const,
  },
  {
    type: 'RWA',
    name: 'TAU',
    address: '0x622efb1fb4a2486b75813aba428639251495eccb',
    network: 'polygon' as const,
  },
  {
    type: 'RWA',
    name: 'MSTO',
    address: '0x05b9cd0ec1fe6bb4e61f4437a56e4aa4b442af5a',
    tokenContract: '0xcbe4c86df7bd5076156a790be70b50f2d3570218',
    network: 'polygon' as const,
  },
  {
    type: 'RWA',
    name: 'CKGP',
    address: '0xec86ceccd8046ed956060988f91c754e7a13328f',
    tokenContract: '0x47d8608e1adb7d600e038ef995ed3951e4b7ded5',
    network: 'polygon' as const,
  }
];

// Pools API configuration

async function fetchPoolValue(pool: typeof POOLS[0], prices: any): Promise<{ usdValue: number; derivedIxsPrice: number | null; debug?: any }> {
  const alchemyNetwork = networkToAlchemy[pool.network];
  const alchemyUrl = `https://${alchemyNetwork}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

  // Helper: call Alchemy with retries + exponential backoff for transient errors
  async function alchemyCall(payload: any, maxRetries = 7) {
    let attempt = 0;
    let delay = 700;
    while (attempt <= maxRetries) {
      try {
        const resp = await axios.post(alchemyUrl, payload, { headers: { 'Content-Type': 'application/json' }, timeout: API_TIMEOUT });
        if (resp.data && resp.data.error) {
          const errMsg = resp.data.error.message || JSON.stringify(resp.data.error);
          if (/rate limit|429|timeout|throttle/i.test(errMsg) && attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, delay));
            attempt++;
            delay *= 2;
            continue;
          }
          throw new Error(errMsg);
        }
        return resp;
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (attempt < maxRetries && /timeout|ECONNRESET|ENOTFOUND|rate limit|429|throttle/i.test(msg)) {
          await new Promise((r) => setTimeout(r, delay));
          attempt++;
          delay *= 2;
          continue;
        }
        throw err;
      }
    }
    throw new Error('alchemyCall: exceeded retries');
  }

  try {
    // Get token0
    const token0Payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: pool.address, data: '0x0dfe1681' }, 'latest'],
    };
    const token0Response = await alchemyCall(token0Payload);
    const token0 = '0x' + (token0Response.data.result || '').slice(-40);

    // Get token1
    const token1Payload = {
      jsonrpc: '2.0',
      id: 2,
      method: 'eth_call',
      params: [{ to: pool.address, data: '0xd21220a7' }, 'latest'],
    };
    const token1Response = await alchemyCall(token1Payload);
    const token1 = '0x' + (token1Response.data.result || '').slice(-40);

    // Get decimals for token0
    const decimals0Payload = {
      jsonrpc: '2.0',
      id: 3,
      method: 'eth_call',
      params: [{ to: token0, data: '0x313ce567' }, 'latest'],
    };
    const decimals0Response = await alchemyCall(decimals0Payload);
    const decimals0 = parseInt(decimals0Response.data.result, 16);

    // Get decimals for token1
    const decimals1Payload = {
      jsonrpc: '2.0',
      id: 4,
      method: 'eth_call',
      params: [{ to: token1, data: '0x313ce567' }, 'latest'],
    };
    const decimals1Response = await alchemyCall(decimals1Payload);
    const decimals1 = parseInt(decimals1Response.data.result, 16);

    // Get reserves
    const reservesPayload = {
      jsonrpc: '2.0',
      id: 5,
      method: 'eth_call',
      params: [{ to: pool.address, data: '0x0902f1ac' }, 'latest'],
    };
    const reservesResponse = await alchemyCall(reservesPayload);
    const result = reservesResponse.data.result;
    const reserve0 = BigInt('0x' + result.slice(2, 66));
    const reserve1 = BigInt('0x' + result.slice(66, 130));

    const reserve0Float = Number(reserve0) / 10 ** decimals0;
    const reserve1Float = Number(reserve1) / 10 ** decimals1;

    // Get prices
    const ixAddress = pool.network === 'polygon' ? (process.env.NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS || '').toLowerCase() : (process.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS || '').toLowerCase();
    const usdcPolygon = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';

    let price0 = 0;
    if (token0.toLowerCase() === ixAddress) price0 = prices.ixs?.usd || 0;
    else if (token0.toLowerCase() === usdcPolygon) price0 = 1;

    let price1 = 0;
    if (token1.toLowerCase() === ixAddress) price1 = prices.ixs?.usd || 0;
    else if (token1.toLowerCase() === usdcPolygon) price1 = 1;

    if ((pool as any).priceSource) {
      if (token0.toLowerCase() === ixAddress && price1 === 0) price1 = 1;
      if (token1.toLowerCase() === ixAddress && price0 === 0) price0 = 1;
    }

    if (price0 > 0 && price1 === 0 && reserve1Float > 0) {
      price1 = (reserve0Float * price0) / reserve1Float;
    } else if (price1 > 0 && price0 === 0 && reserve0Float > 0) {
      price0 = (reserve1Float * price1) / reserve0Float;
    }

    const usdValue = reserve0Float * price0 + reserve1Float * price1;
    let derivedIxsPrice: number | null = null;
    if (token0.toLowerCase() === ixAddress && price0 > 0) derivedIxsPrice = price0;
    if (token1.toLowerCase() === ixAddress && price1 > 0) derivedIxsPrice = price1;

    const debug = { token0, token1, decimals0, decimals1, reserve0Float, reserve1Float, price0, price1, usdValue };
    return { usdValue, derivedIxsPrice, debug };
  } catch (error) {
    let errMsg = 'unknown error';
    if (error instanceof Error && error.message) {
      errMsg = error.message;
    } else {
      try {
        errMsg = JSON.stringify(error);
      } catch (e) {
        errMsg = String(error);
      }
    }
    console.error(`[pools API] Error fetching ${pool.name} pool value:`, errMsg);
    const debug = { error: errMsg };
    return { usdValue: 0, derivedIxsPrice: null, debug };
  }
}

// Debug helper removed



// Simple GET handler: compute pool values, scrape volumes, and return JSON
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const debugMode = url.searchParams.get('debug') === '1' || url.searchParams.get('debug') === 'true';

    // basic validation
    if (!ALCHEMY_API_KEY) {
      console.warn('[pools API] ALCHEMY_API_KEY not set; eth_calls may fail');
    }

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let prices: any = {};
    const warnings: string[] = [];

    const poolsData: any[] = [];
    const poolsDebug: any[] = [];

    for (const pool of POOLS) {
      // small pacing between pools
      if (poolsData.length > 0) await sleep(WAIT_BETWEEN_POOLS_MS);
      const result = await fetchPoolValue(pool, prices);
      if (result.derivedIxsPrice && result.derivedIxsPrice > 0) prices['ixs'] = { usd: result.derivedIxsPrice };
      if (debugMode) {
        poolsData.push({ ...pool, value: result.usdValue, debug: result.debug });
        poolsDebug.push({ name: pool.name, address: pool.address, network: pool.network, debug: result.debug, derivedIxsPrice: result.derivedIxsPrice });
      } else {
        poolsData.push({ ...pool, value: result.usdValue });
      }
    }

    // HTML scraping removed by request — no external scraping performed here.

    const body: any = { pools: poolsData };
    if (warnings.length > 0) body.warnings = warnings;
    if (debugMode) body.debug = { prices, pools: poolsDebug };

    return NextResponse.json(body, { status: 200, headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' } });
  } catch (error) {
    console.error('[pools API] Unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}