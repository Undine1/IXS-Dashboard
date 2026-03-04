import { NextResponse } from 'next/server';

interface DuneHolderRow {
  rank?: number | string;
  holder?: string;
  chains_holding?: number | string;
  total_ixs?: string;
}

interface DuneQueryResults {
  execution_id?: string;
  state?: string;
  execution_ended_at?: string;
  submitted_at?: string;
  result?: {
    rows?: DuneHolderRow[];
    metadata?: {
      total_row_count?: number;
    };
  };
}

interface HolderRankingRow {
  rank: number;
  holder: string;
  chainsHolding: number;
  totalIxs: string;
}

const DEFAULT_QUERY_ID = 6777216;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const DEFAULT_CACHE_TTL_SECONDS = 300;
const MIN_CACHE_TTL_SECONDS = 30;
const MAX_CACHE_TTL_SECONDS = 3600;

interface HolderRankingsSuccessPayload {
  ok: true;
  queryId: number;
  executionId: string | null;
  executionState: string | null;
  lastRefreshed: string | null;
  totalRowCount: number;
  rows: HolderRankingRow[];
}

let cachedPayload: HolderRankingsSuccessPayload | null = null;
let cachedAtMs = 0;
let inFlightFetch: Promise<HolderRankingsSuccessPayload> | null = null;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeRow(row: DuneHolderRow, index: number): HolderRankingRow | null {
  const holder = typeof row.holder === 'string' ? row.holder.toLowerCase() : '';
  if (!/^0x[0-9a-f]{40}$/.test(holder)) return null;

  const rank = toFiniteNumber(row.rank) ?? index + 1;
  const chainsHolding = toFiniteNumber(row.chains_holding) ?? 0;
  const totalIxs = typeof row.total_ixs === 'string' && row.total_ixs.trim() !== ''
    ? row.total_ixs
    : '0.00';

  return {
    rank: Math.max(1, Math.floor(rank)),
    holder,
    chainsHolding: Math.max(0, Math.floor(chainsHolding)),
    totalIxs,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function fetchLatestSavedResults(
  apiKey: string,
  queryId: number,
  limit: number,
): Promise<HolderRankingsSuccessPayload> {
  // This endpoint reads the latest saved execution for the query id.
  // It does not trigger a new query run.
  const resultsResponse = await fetch(
    `https://api.dune.com/api/v1/query/${queryId}/results?limit=${limit}`,
    {
      method: 'GET',
      headers: { 'X-DUNE-API-KEY': apiKey },
      cache: 'no-store',
    },
  );

  if (!resultsResponse.ok) {
    const text = await resultsResponse.text();
    throw new Error(`Dune query results request failed (${resultsResponse.status}): ${text}`);
  }

  const payload = (await resultsResponse.json()) as DuneQueryResults;
  const rawRows = Array.isArray(payload?.result?.rows) ? payload.result.rows : [];
  const rows = rawRows
    .map((row, index) => normalizeRow(row, index))
    .filter((row): row is HolderRankingRow => row !== null);

  const totalRowCount = toFiniteNumber(payload?.result?.metadata?.total_row_count) ?? rows.length;
  const lastRefreshed = payload.execution_ended_at || payload.submitted_at || null;

  return {
    ok: true,
    queryId,
    executionId: payload.execution_id || null,
    executionState: payload.state || null,
    lastRefreshed,
    totalRowCount: Math.max(rows.length, Math.floor(totalRowCount)),
    rows,
  };
}

export async function GET() {
  const apiKey = process.env.DUNE_API_KEY || process.env.DUNE_API_TOKEN;
  if (!apiKey) {
    return NextResponse.json(
      {
        ok: false,
        error: 'DUNE_API_KEY is not configured',
        rows: [],
        totalRowCount: 0,
        lastRefreshed: null,
      },
      { status: 500 },
    );
  }

  const queryId = toFiniteNumber(process.env.DUNE_HOLDER_RANKINGS_QUERY_ID) ?? DEFAULT_QUERY_ID;
  const configuredLimit = toFiniteNumber(process.env.DUNE_HOLDER_RANKINGS_LIMIT) ?? DEFAULT_LIMIT;
  const limit = Math.min(Math.max(Math.floor(configuredLimit), 1), MAX_LIMIT);
  const normalizedQueryId = Math.floor(queryId);
  const configuredCacheTtlSeconds =
    toFiniteNumber(process.env.DUNE_HOLDER_RANKINGS_CACHE_TTL_SECONDS) ?? DEFAULT_CACHE_TTL_SECONDS;
  const cacheTtlSeconds = Math.floor(
    clamp(configuredCacheTtlSeconds, MIN_CACHE_TTL_SECONDS, MAX_CACHE_TTL_SECONDS),
  );
  const cacheTtlMs = cacheTtlSeconds * 1000;

  try {
    const now = Date.now();
    const cacheIsValid = cachedPayload && now - cachedAtMs < cacheTtlMs;
    if (cacheIsValid) {
      return NextResponse.json(cachedPayload);
    }

    if (!inFlightFetch) {
      inFlightFetch = fetchLatestSavedResults(apiKey, normalizedQueryId, limit);
    }

    const freshPayload = await inFlightFetch;
    cachedPayload = freshPayload;
    cachedAtMs = Date.now();

    return NextResponse.json(freshPayload);
  } catch (error) {
    if (cachedPayload) {
      return NextResponse.json(cachedPayload);
    }

    return NextResponse.json(
      {
        ok: false,
        error: 'Failed to fetch holder rankings',
        details: error instanceof Error ? error.message : String(error),
        rows: [],
        totalRowCount: 0,
        lastRefreshed: null,
      },
      { status: 500 },
    );
  } finally {
    inFlightFetch = null;
  }
}
