// Relative imports (not the @/ alias) so scripts/update_onchain_snapshot.ts
// can run this module under tsx in CI.
import type { ChainNetwork } from '../types';
import { getRpcUrls, hasAnyRpcConfigured, rpcCall, sleep } from './rpc';
import { bigintToDecimalNumber, normalizeAddressFromHex, parseHexInt } from './poolMath';
import { POOLS, type PoolConfig } from './poolsConfig';
import { readSnapshotSection } from './onchainSnapshot';

// Core pool-valuation logic, shared by /api/pools, /metrics, and the CI
// snapshot script. Serving order at request time: hourly committed snapshot
// -> per-instance memory cache -> live RPC fan-out (fallback only).

// Matches the updaters' RPC_MIN_INTERVAL_MS pacing: enough to flatten the
// burst (≤10 req/s) without padding the function's billed wall-time.
const WAIT_BETWEEN_POOLS_MS = 100;

type NetworkPrices = {
  ixs?: { usd: number };
};

type Prices = Partial<Record<ChainNetwork, NetworkPrices>>;

export type PoolDebug = {
  token0?: string;
  token1?: string;
  decimals0?: number;
  decimals1?: number;
  reserve0Float?: number;
  reserve1Float?: number;
  price0?: number;
  price1?: number;
  usdValue?: number | null;
  error?: string;
};

export type PoolWithValue = PoolConfig & {
  value: number | null;
  debug?: PoolDebug;
};

type FetchPoolResult = {
  usdValue: number | null;
  derivedIxsPrice: number | null;
  debug: PoolDebug;
};

export type PoolsResponseBody = {
  pools: PoolWithValue[];
  warnings?: string[];
  debug?: {
    prices: Prices;
    pools: Array<{
      name: string;
      address: string;
      network: ChainNetwork;
      debug: PoolDebug;
      derivedIxsPrice: number | null;
    }>;
  };
};

export type PoolsServiceResult = {
  body: PoolsResponseBody;
  // True when every pool resolved to a numeric USD value. Unhealthy results
  // are never cached so an RPC outage cannot get pinned for an hour.
  healthy: boolean;
  fromCache: boolean;
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

// IXS prices are derived while iterating: a pool paired with a stable (or
// flagged priceSource) yields the network's IXS price, which later pools on
// the same network need for their valuation. Processing in tier order makes
// that derivation independent of the POOLS config order.
function poolPricingTier(pool: PoolConfig): number {
  if (pool.priceSource) return 0;
  const stables = STABLE_TOKENS_BY_NETWORK[pool.network] || [];
  if (
    pool.meta &&
    (stables.includes(pool.meta.token0.toLowerCase()) || stables.includes(pool.meta.token1.toLowerCase()))
  ) {
    return 1;
  }
  return 2;
}

async function fetchPoolValue(pool: PoolConfig, prices: Prices): Promise<FetchPoolResult> {
  const rpcUrls = getRpcUrls(pool.network);

  try {
    let token0: string;
    let token1: string;
    let decimals0: number;
    let decimals1: number;

    if (pool.meta) {
      // token0/token1/decimals are immutable for a V2 pair — reuse the baked-in
      // values instead of spending four eth_calls per request to rediscover them.
      token0 = pool.meta.token0.toLowerCase();
      token1 = pool.meta.token1.toLowerCase();
      decimals0 = pool.meta.decimals0;
      decimals1 = pool.meta.decimals1;
    } else {
      const token0Hex = await rpcCall(rpcUrls, {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: pool.address, data: '0x0dfe1681' }, 'latest'],
      });
      const token1Hex = await rpcCall(rpcUrls, {
        jsonrpc: '2.0',
        id: 2,
        method: 'eth_call',
        params: [{ to: pool.address, data: '0xd21220a7' }, 'latest'],
      });
      const decimals0Hex = await rpcCall(rpcUrls, {
        jsonrpc: '2.0',
        id: 3,
        method: 'eth_call',
        params: [{ to: normalizeAddressFromHex(token0Hex), data: '0x313ce567' }, 'latest'],
      });
      const decimals1Hex = await rpcCall(rpcUrls, {
        jsonrpc: '2.0',
        id: 4,
        method: 'eth_call',
        params: [{ to: normalizeAddressFromHex(token1Hex), data: '0x313ce567' }, 'latest'],
      });
      token0 = normalizeAddressFromHex(token0Hex);
      token1 = normalizeAddressFromHex(token1Hex);
      decimals0 = parseHexInt(decimals0Hex, 'token0 decimals');
      decimals1 = parseHexInt(decimals1Hex, 'token1 decimals');
    }

    const reservesHex = await rpcCall(rpcUrls, {
      jsonrpc: '2.0',
      id: 5,
      method: 'eth_call',
      params: [{ to: pool.address, data: '0x0902f1ac' }, 'latest'],
    });

    if (reservesHex.length < 130) {
      throw new Error('invalid reserves result');
    }

    const reserve0 = BigInt(`0x${reservesHex.slice(2, 66)}`);
    const reserve1 = BigInt(`0x${reservesHex.slice(66, 130)}`);

    const reserve0Float = bigintToDecimalNumber(reserve0, decimals0);
    const reserve1Float = bigintToDecimalNumber(reserve1, decimals1);

    const ixsAddress = IXS_ADDRESS_BY_NETWORK[pool.network];
    const stableTokens = STABLE_TOKENS_BY_NETWORK[pool.network] || [];
    const knownIxsUsd = prices[pool.network]?.ixs?.usd;
    const token0Lower = token0.toLowerCase();
    const token1Lower = token1.toLowerCase();

    let price0: number | null = null;
    if (token0Lower === ixsAddress && typeof knownIxsUsd === 'number' && knownIxsUsd > 0) {
      price0 = knownIxsUsd;
    } else if (stableTokens.includes(token0Lower)) {
      price0 = 1;
    }

    let price1: number | null = null;
    if (token1Lower === ixsAddress && typeof knownIxsUsd === 'number' && knownIxsUsd > 0) {
      price1 = knownIxsUsd;
    } else if (stableTokens.includes(token1Lower)) {
      price1 = 1;
    }

    if (pool.priceSource) {
      if (token0Lower === ixsAddress && price1 === null) price1 = 1;
      if (token1Lower === ixsAddress && price0 === null) price0 = 1;
    }

    if (price0 !== null && price0 > 0 && price1 === null && reserve1Float > 0) {
      price1 = (reserve0Float * price0) / reserve1Float;
    } else if (price1 !== null && price1 > 0 && price0 === null && reserve0Float > 0) {
      price0 = (reserve1Float * price1) / reserve0Float;
    }

    const hasPrice0 = price0 !== null && Number.isFinite(price0) && price0 >= 0;
    const hasPrice1 = price1 !== null && Number.isFinite(price1) && price1 >= 0;
    const price0Value = hasPrice0 ? (price0 ?? 0) : 0;
    const price1Value = hasPrice1 ? (price1 ?? 0) : 0;
    const usdValue = hasPrice0 || hasPrice1
      ? reserve0Float * price0Value + reserve1Float * price1Value
      : null;
    let derivedIxsPrice: number | null = null;
    if (token0Lower === ixsAddress && hasPrice0 && price0Value > 0) derivedIxsPrice = price0Value;
    if (token1Lower === ixsAddress && hasPrice1 && price1Value > 0) derivedIxsPrice = price1Value;

    const debug: PoolDebug = {
      token0,
      token1,
      decimals0,
      decimals1,
      reserve0Float,
      reserve1Float,
      ...(hasPrice0 ? { price0: price0Value } : {}),
      ...(hasPrice1 ? { price1: price1Value } : {}),
      usdValue,
    };

    return { usdValue, derivedIxsPrice, debug };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[pools service] Error fetching ${pool.name} pool value:`, errMsg);
    return { usdValue: null, derivedIxsPrice: null, debug: { error: errMsg } };
  }
}

// Best-effort per-instance cache. This is lost on serverless cold starts and is
// NOT a correctness guarantee — the durable layer is the CDN (s-maxage set by
// the routes). It avoids re-running the RPC fan-out for repeat hits on a warm
// instance (e.g. the /metrics composition). Only healthy payloads are stored.
const POOLS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let cachedBody: PoolsResponseBody | null = null;
let cachedAtMs = 0;

export async function getPoolsBody(
  options: { forceFresh?: boolean; debug?: boolean } = {},
): Promise<PoolsServiceResult> {
  const debugMode = Boolean(options.debug);
  const forceFresh = Boolean(options.forceFresh);

  if (!debugMode && !forceFresh) {
    // The hourly pipeline snapshots this data; only sections that fetched
    // healthily are stored, so a stored section can be served as-is.
    const snapshot = readSnapshotSection('pools');
    if (snapshot && Array.isArray(snapshot.data?.pools) && snapshot.data.pools.length > 0) {
      return { body: snapshot.data, healthy: true, fromCache: true };
    }

    if (cachedBody && Date.now() - cachedAtMs < POOLS_CACHE_TTL_MS) {
      return { body: cachedBody, healthy: true, fromCache: true };
    }
  }

  const result = await computePoolsBody({ debug: debugMode });

  // Only cache the canonical (non-debug) payload, and only when healthy.
  if (!debugMode && result.healthy) {
    cachedBody = result.body;
    cachedAtMs = Date.now();
  }

  return result;
}

// Pure live RPC fan-out, no snapshot/cache involvement. Exported for the CI
// snapshot script.
export async function computePoolsBody(
  options: { debug?: boolean } = {},
): Promise<PoolsServiceResult> {
  const debugMode = Boolean(options.debug);

  if (!hasAnyRpcConfigured()) {
    console.warn('[pools service] No RPC API key is set; eth_calls will fail');
  }

  const prices: Prices = {};
  const warnings: string[] = [];
  const resultsByIndex = new Array<FetchPoolResult>(POOLS.length);

  // Process price-source/stable-paired pools first so derived IXS prices exist
  // before dependent pools are valued; emit results in POOLS order so the
  // response shape is unaffected.
  const processingOrder = POOLS.map((pool, index) => ({ pool, index })).sort(
    (left, right) => poolPricingTier(left.pool) - poolPricingTier(right.pool) || left.index - right.index,
  );

  let processedAny = false;
  for (const { pool, index } of processingOrder) {
    if (processedAny) {
      await sleep(WAIT_BETWEEN_POOLS_MS);
    }
    processedAny = true;

    const result = await fetchPoolValue(pool, prices);
    if (result.derivedIxsPrice && result.derivedIxsPrice > 0) {
      const current = prices[pool.network] || {};
      current.ixs = { usd: result.derivedIxsPrice };
      prices[pool.network] = current;
    }
    resultsByIndex[index] = result;
  }

  const poolsData: PoolWithValue[] = [];
  const poolsDebug: NonNullable<PoolsResponseBody['debug']>['pools'] = [];

  POOLS.forEach((pool, index) => {
    const result = resultsByIndex[index];
    if (result.debug.error) {
      warnings.push(`${pool.name} (${pool.network}): ${result.debug.error}`);
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
  });

  const body: PoolsResponseBody = { pools: poolsData };
  if (warnings.length > 0) body.warnings = warnings;
  if (debugMode) body.debug = { prices, pools: poolsDebug };

  const healthy =
    poolsData.length > 0 && poolsData.every((pool) => typeof pool.value === 'number' && Number.isFinite(pool.value));

  return { body, healthy, fromCache: false };
}
