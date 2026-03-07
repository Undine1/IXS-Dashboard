import { promises as fs } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface HolderRankingRow {
  rank: number;
  holder: string;
  chainsHolding: number;
  totalIxs: string;
  label: string | null;
  labelCategory: string | null;
}

interface HolderRankingsSuccessPayload {
  ok: true;
  rows: HolderRankingRow[];
  totalRowCount: number;
  lastRefreshed: string | null;
}

interface HolderRankingsErrorPayload {
  ok: false;
  error: string;
  details?: string;
  rows: HolderRankingRow[];
  totalRowCount: number;
  lastRefreshed: string | null;
}

interface HolderRankingsSnapshot {
  ok?: boolean;
  rows?: unknown[];
  totalRowCount?: number | string;
  lastRefreshed?: string | null;
}

const HOLDER_RANKINGS_FILE = path.join(process.cwd(), 'public', 'data', 'holder_rankings.json');
const DEFAULT_CACHE_TTL_SECONDS = 300;
const MIN_CACHE_TTL_SECONDS = 30;
const MAX_CACHE_TTL_SECONDS = 3600;

let cachedPayload: HolderRankingsSuccessPayload | null = null;
let cachedAtMs = 0;
let inFlightRead: Promise<HolderRankingsSuccessPayload> | null = null;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeRow(row: unknown, index: number): HolderRankingRow | null {
  if (!row || typeof row !== 'object') return null;

  const payload = row as Record<string, unknown>;
  const holder = typeof payload.holder === 'string' ? payload.holder.toLowerCase() : '';
  if (!/^0x[0-9a-f]{40}$/.test(holder)) return null;

  const rank = Math.max(1, Math.floor(toFiniteNumber(payload.rank) ?? index + 1));
  const chainsHolding = Math.max(0, Math.floor(toFiniteNumber(payload.chainsHolding) ?? 0));
  const totalIxs =
    typeof payload.totalIxs === 'string' && payload.totalIxs.trim() !== '' ? payload.totalIxs : '0.00';
  const label = typeof payload.label === 'string' && payload.label.trim() !== '' ? payload.label.trim() : null;
  const labelCategory =
    typeof payload.labelCategory === 'string' && payload.labelCategory.trim() !== ''
      ? payload.labelCategory.trim().toLowerCase()
      : null;

  return {
    rank,
    holder,
    chainsHolding,
    totalIxs,
    label,
    labelCategory,
  };
}

async function readSnapshotFromDisk(): Promise<HolderRankingsSuccessPayload> {
  const raw = await fs.readFile(HOLDER_RANKINGS_FILE, 'utf8');
  const payload = JSON.parse(raw) as HolderRankingsSnapshot;
  const rawRows = Array.isArray(payload.rows) ? payload.rows : [];
  const rows = rawRows
    .map((row, index) => normalizeRow(row, index))
    .filter((row): row is HolderRankingRow => row !== null);
  const totalRowCount = toFiniteNumber(payload.totalRowCount) ?? rows.length;

  return {
    ok: true,
    rows,
    totalRowCount: Math.max(rows.length, Math.floor(totalRowCount)),
    lastRefreshed: typeof payload.lastRefreshed === 'string' ? payload.lastRefreshed : null,
  };
}

function json(payload: HolderRankingsSuccessPayload | HolderRankingsErrorPayload, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET() {
  const configuredCacheTtlSeconds =
    toFiniteNumber(process.env.HOLDER_RANKINGS_CACHE_TTL_SECONDS) ??
    toFiniteNumber(process.env.DUNE_HOLDER_RANKINGS_CACHE_TTL_SECONDS) ??
    DEFAULT_CACHE_TTL_SECONDS;
  const cacheTtlSeconds = Math.floor(
    clamp(configuredCacheTtlSeconds, MIN_CACHE_TTL_SECONDS, MAX_CACHE_TTL_SECONDS),
  );
  const cacheTtlMs = cacheTtlSeconds * 1000;

  try {
    const now = Date.now();
    if (cachedPayload && now - cachedAtMs < cacheTtlMs) {
      return json(cachedPayload);
    }

    if (!inFlightRead) {
      inFlightRead = readSnapshotFromDisk();
    }

    const freshPayload = await inFlightRead;
    cachedPayload = freshPayload;
    cachedAtMs = Date.now();

    return json(freshPayload);
  } catch (error) {
    if (cachedPayload) {
      return json(cachedPayload);
    }

    return json(
      {
        ok: false,
        error: 'Failed to read holder rankings snapshot',
        details: error instanceof Error ? error.message : String(error),
        rows: [],
        totalRowCount: 0,
        lastRefreshed: null,
      },
      500,
    );
  } finally {
    inFlightRead = null;
  }
}
