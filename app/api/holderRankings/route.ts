import { promises as fs } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-static';
export const revalidate = false;

interface HolderRankingRow {
  rank: number;
  holder: string;
  chainsHolding: number;
  totalIxs: string;
  label: string | null;
}

interface HolderRankingsSuccessPayload {
  ok: true;
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

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
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

  return {
    rank,
    holder,
    chainsHolding,
    totalIxs,
    label,
  };
}

export function normalizeHolderRankingsSnapshot(raw: unknown): HolderRankingsSuccessPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('holder rankings snapshot must be an object');
  }

  const payload = raw as HolderRankingsSnapshot;
  if (payload.ok === false || !Array.isArray(payload.rows)) {
    throw new Error('holder rankings snapshot must contain a successful rows array');
  }

  const rawRows = Array.isArray(payload.rows) ? payload.rows : [];
  const rows = rawRows
    .map((row, index) => normalizeRow(row, index))
    .filter((row): row is HolderRankingRow => row !== null);
  if (rows.length !== rawRows.length) {
    throw new Error('holder rankings snapshot contains an invalid row');
  }

  const totalRowCount = toFiniteNumber(payload.totalRowCount) ?? rows.length;
  if (typeof payload.lastRefreshed === 'string' && !Number.isFinite(Date.parse(payload.lastRefreshed))) {
    throw new Error('holder rankings snapshot has an invalid lastRefreshed timestamp');
  }

  return {
    ok: true,
    rows,
    totalRowCount: Math.max(rows.length, Math.floor(totalRowCount)),
    lastRefreshed: typeof payload.lastRefreshed === 'string' ? payload.lastRefreshed : null,
  };
}

async function readSnapshotFromDisk(): Promise<HolderRankingsSuccessPayload> {
  const raw = await fs.readFile(HOLDER_RANKINGS_FILE, 'utf8');
  return normalizeHolderRankingsSnapshot(JSON.parse(raw));
}

function json(payload: HolderRankingsSuccessPayload) {
  return NextResponse.json(payload, {
    headers: {
      // This route is prerendered from a deployment-baked file. Browsers still
      // revalidate, while the CDN can retain the immutable deployment result;
      // publishing refreshed data creates a new deployment/cache namespace.
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Vercel-CDN-Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

export async function GET() {
  try {
    return json(await readSnapshotFromDisk());
  } catch (error) {
    throw new Error(
      `Invalid deployment-baked holder rankings snapshot: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}
