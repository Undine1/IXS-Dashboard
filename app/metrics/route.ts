import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type PoolEntry = {
  value?: number | null;
};

type PoolsApiResponse = {
  pools?: PoolEntry[];
};

type BurnNetworkBalances = {
  balances?: Record<string, string | null>;
};

type BurnStatsApiResponse = {
  ethereum?: BurnNetworkBalances;
  polygon?: BurnNetworkBalances;
  base?: BurnNetworkBalances;
};

const DEFAULT_TOTAL_SUPPLY = 180000000;
const DEFAULT_TOKEN_DECIMALS = 18;

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extra,
  };
}

function parseFiniteNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseTotalSupply(): number {
  const fromEnv =
    process.env.TOTAL_SUPPLY ??
    process.env.NEXT_PUBLIC_TOTAL_SUPPLY ??
    process.env.MAX_SUPPLY ??
    process.env.NEXT_PUBLIC_MAX_SUPPLY;
  return parseFiniteNumber(fromEnv, DEFAULT_TOTAL_SUPPLY);
}

function parseTokenDecimals(): number {
  const raw =
    process.env.TOKEN_DECIMALS ??
    process.env.NEXT_PUBLIC_TOKEN_DECIMALS;
  const decimals = parseFiniteNumber(raw, DEFAULT_TOKEN_DECIMALS);
  return Math.max(0, Math.floor(decimals));
}

function toBigIntSafe(value: string | null | undefined): bigint {
  if (!value) return BigInt(0);
  if (!/^\d+$/.test(value)) return BigInt(0);
  return BigInt(value);
}

function computeTotalTokensBurned(stats: BurnStatsApiResponse, decimals: number): number {
  const networks: Array<keyof BurnStatsApiResponse> = ['ethereum', 'polygon', 'base'];
  let totalRaw = BigInt(0);

  for (const network of networks) {
    const balances = stats?.[network]?.balances;
    if (!balances || typeof balances !== 'object') continue;
    for (const balance of Object.values(balances)) {
      totalRaw += toBigIntSafe(balance);
    }
  }

  if (decimals <= 0) return Number(totalRaw);
  const divisor = BigInt(10) ** BigInt(decimals);
  const wholeTokens = totalRaw / divisor;
  return Number(wholeTokens);
}

function computeTvlUsd(pools: PoolsApiResponse): number {
  const list = Array.isArray(pools?.pools) ? pools.pools : [];
  let total = 0;
  for (const pool of list) {
    const value = parseFiniteNumber(pool?.value, 0);
    if (value > 0) total += value;
  }
  return Number(total.toFixed(2));
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders({ 'Cache-Control': 'no-store' }),
  });
}

export async function GET(req: Request) {
  try {
    const origin = new URL(req.url).origin;
    const nonce = Date.now();

    const [poolsRes, burnRes] = await Promise.all([
      fetch(`${origin}/api/pools?t=${nonce}`, { cache: 'no-store' }),
      fetch(`${origin}/api/burnStats?fresh=1&t=${nonce}`, { cache: 'no-store' }),
    ]);

    if (!poolsRes.ok || !burnRes.ok) {
      throw new Error(`Upstream API error: pools=${poolsRes.status}, burnStats=${burnRes.status}`);
    }

    const poolsJson = (await poolsRes.json()) as PoolsApiResponse;
    const burnJson = (await burnRes.json()) as BurnStatsApiResponse;

    const tvl_usd = computeTvlUsd(poolsJson);
    const total_tokens_burned = computeTotalTokensBurned(burnJson, parseTokenDecimals());
    const total_supply = parseTotalSupply();
    const circulating_supply = Math.max(0, total_supply - total_tokens_burned);

    return NextResponse.json(
      {
        tvl_usd,
        total_tokens_burned,
        total_supply,
        circulating_supply,
      },
      {
        status: 200,
        headers: corsHeaders({ 'Cache-Control': 'no-store' }),
      }
    );
  } catch (error) {
    console.error('[metrics API] Unexpected error:', error);
    return NextResponse.json(
      { error: 500 },
      {
        status: 500,
        headers: corsHeaders({ 'Cache-Control': 'no-store' }),
      }
    );
  }
}
