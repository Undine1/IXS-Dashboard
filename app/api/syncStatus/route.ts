import { promises as fs } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-static';
export const revalidate = false;

const HOLDER_RANKINGS_FILE = path.join(process.cwd(), 'public', 'data', 'holder_rankings.json');
const POOL_VOLUME_FILE = path.join(process.cwd(), 'public', 'data', 'pool_volume.json');
const ONCHAIN_SNAPSHOT_FILE = path.join(process.cwd(), 'public', 'data', 'onchain_snapshot.json');

type SyncStatusPayload = {
  ok: true;
  lastDeploymentCompletedAt: string | null;
  source: 'snapshot' | 'unavailable';
};

function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber > 1e12 ? asNumber : asNumber * 1000;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function collectPoolVolumeTimestamps(source: unknown): number[] {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return [];

  const payload = source as Record<string, unknown>;
  const timestamps: number[] = [];
  const topLevelLastUpdated = toEpochMs(payload.lastUpdated);
  if (topLevelLastUpdated) timestamps.push(topLevelLastUpdated);

  const poolsSource =
    payload.pools && typeof payload.pools === 'object' && !Array.isArray(payload.pools)
      ? (payload.pools as Record<string, unknown>)
      : payload;

  for (const entry of Object.values(poolsSource)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const lastUpdated = toEpochMs((entry as Record<string, unknown>).lastUpdated);
    if (lastUpdated) timestamps.push(lastUpdated);
  }

  return timestamps;
}

function collectOnchainSnapshotTimestamps(source: unknown): number[] {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return [];

  const timestamps: number[] = [];
  for (const section of Object.values(source as Record<string, unknown>)) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
    const generatedAt = toEpochMs((section as Record<string, unknown>).generatedAt);
    if (generatedAt) timestamps.push(generatedAt);
  }
  return timestamps;
}

export function resolveSyncStatusSnapshots(
  holderSnapshot: unknown,
  poolSnapshot: unknown,
  onchainSnapshot: unknown,
): SyncStatusPayload {
  const timestamps: number[] = [
    ...collectPoolVolumeTimestamps(poolSnapshot),
    ...collectOnchainSnapshotTimestamps(onchainSnapshot),
  ];

  if (holderSnapshot && typeof holderSnapshot === 'object' && !Array.isArray(holderSnapshot)) {
    const lastRefreshed = toEpochMs(
      (holderSnapshot as Record<string, unknown>).lastRefreshed,
    );
    if (lastRefreshed) timestamps.push(lastRefreshed);
  }

  if (timestamps.length === 0) {
    return {
      ok: true,
      lastDeploymentCompletedAt: null,
      source: 'unavailable',
    };
  }

  return {
    ok: true,
    lastDeploymentCompletedAt: new Date(Math.max(...timestamps)).toISOString(),
    source: 'snapshot',
  };
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export async function GET() {
  const [holderSnapshot, poolSnapshot, onchainSnapshot] = await Promise.all([
    readJson(HOLDER_RANKINGS_FILE),
    readJson(POOL_VOLUME_FILE),
    readJson(ONCHAIN_SNAPSHOT_FILE),
  ]);
  const payload = resolveSyncStatusSnapshots(holderSnapshot, poolSnapshot, onchainSnapshot);

  return NextResponse.json(payload, {
    headers: {
      // These timestamps are baked into the deployment. A refreshed data
      // commit creates a new deployment/cache namespace, so no runtime GitHub
      // request or cross-deployment stale response is needed.
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Vercel-CDN-Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
