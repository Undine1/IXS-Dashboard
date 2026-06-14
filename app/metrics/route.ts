import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PRIVATE_ENTRY } from '@/lib/tvlConfig';
import { getPoolsBody, type PoolsResponseBody } from '@/lib/poolsService';
import { getBurnStatsBody, type BurnStatsApiResponse } from '@/lib/burnStatsService';
import { getTotalSupply } from '@/lib/supply';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Public aggregate endpoint with stable shape — external sites consume this
// (burn/supply figures), so the response fields and CORS headers must not
// change. Composes the pools and burn-stats services with direct calls; both
// serve from their in-memory caches between hourly refreshes, so a /metrics
// hit costs no RPC fan-out on a warm instance.

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

function computeTvlUsd(pools: PoolsResponseBody): number {
  const list = Array.isArray(pools?.pools) ? pools.pools : [];
  let total = 0;
  for (const pool of list) {
    const value = parseFiniteNumber(pool?.value, 0);
    if (value > 0) total += value;
  }
  return Number(total.toFixed(2));
}

function readPrivateTvlValue(): number {
  try {
    const tvlConfigPath = path.join(process.cwd(), 'public', 'data', 'tvlConfig.json');
    const raw = fs.readFileSync(tvlConfigPath, 'utf8');
    const parsed = JSON.parse(raw) as { privateEntry?: { value?: number | string | null } };
    const value = parseFiniteNumber(parsed?.privateEntry?.value, Number(PRIVATE_ENTRY.value ?? 0));
    return value > 0 ? value : 0;
  } catch {
    const fallback = Number(PRIVATE_ENTRY.value ?? 0);
    return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders({ 'Cache-Control': 'no-store' }),
  });
}

export async function GET() {
  try {
    const [poolsResult, burnResult] = await Promise.all([
      getPoolsBody(),
      getBurnStatsBody(),
    ]);

    const tvl_usd = Number((computeTvlUsd(poolsResult.body) + readPrivateTvlValue()).toFixed(2));
    const total_tokens_burned = computeTotalTokensBurned(burnResult.payload, parseTokenDecimals());
    const total_supply = getTotalSupply();
    const circulating_supply = Math.max(0, total_supply - total_tokens_burned);

    // Degraded inputs (any pool unvalued or burn balance missing) get a short
    // CDN TTL so the published figures recover quickly after an RPC hiccup.
    const healthy = poolsResult.healthy && burnResult.healthy;

    return NextResponse.json(
      {
        tvl_usd,
        total_tokens_burned,
        total_supply,
        circulating_supply,
      },
      {
        status: 200,
        headers: corsHeaders({
          'Cache-Control': healthy
            ? 'public, s-maxage=3600, stale-while-revalidate=7200'
            : 'public, s-maxage=60',
        }),
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
