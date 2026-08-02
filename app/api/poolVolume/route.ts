import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-static';
export const revalidate = false;

type PoolVolumeEntry = {
  total_usd?: number | string;
  lastUpdated?: number | string;
  chain?: string;
  usdc?: string;
  address?: string;
};

function isAddressKey(key: string): boolean {
  return /^0x[0-9a-f]{40}$/i.test(key);
}

function parseLastUpdated(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resolveLastUpdated(
  source: Record<string, unknown>,
  pools: Record<string, PoolVolumeEntry>,
): number {
  if (source.lastUpdated !== undefined && source.lastUpdated !== null && source.lastUpdated !== '') {
    const topLevelTimestamp = parseLastUpdated(source.lastUpdated);
    if (topLevelTimestamp !== null) return topLevelTimestamp;
    throw new Error('pool volume snapshot has an invalid lastUpdated timestamp');
  }

  const entryTimestamps = Object.values(pools)
    .map((entry) => parseLastUpdated(entry.lastUpdated))
    .filter((timestamp): timestamp is number => timestamp !== null);
  if (entryTimestamps.length > 0) return Math.max(...entryTimestamps);

  throw new Error('pool volume snapshot has no valid lastUpdated timestamp');
}

export function normalizePoolVolume(raw: unknown): { pools: Record<string, PoolVolumeEntry>; lastUpdated: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('pool volume snapshot must be an object');
  }

  const source = raw as Record<string, unknown>;
  const normalized: Record<string, PoolVolumeEntry> = {};

  const rawPools = source.pools;
  if (rawPools != null && (typeof rawPools !== 'object' || Array.isArray(rawPools))) {
    throw new Error('pool volume snapshot pools must be an object');
  }
  if (rawPools && typeof rawPools === 'object' && !Array.isArray(rawPools)) {
    for (const [address, entry] of Object.entries(rawPools)) {
      if (!isAddressKey(address) || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`pool volume snapshot contains an invalid pool entry: ${address}`);
      }
      normalized[address.toLowerCase()] = entry as PoolVolumeEntry;
    }
  }

  // Backward compatibility for legacy flat-object formats keyed by pool address.
  for (const [key, value] of Object.entries(source)) {
    if (!isAddressKey(key)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`pool volume snapshot contains an invalid legacy pool entry: ${key}`);
    }
    normalized[key.toLowerCase()] = value as PoolVolumeEntry;
  }

  return { pools: normalized, lastUpdated: resolveLastUpdated(source, normalized) };
}

export async function GET() {
  try {
    const file = path.join(process.cwd(), 'public', 'data', 'pool_volume.json');
    const raw = fs.readFileSync(file, 'utf8');
    const data = normalizePoolVolume(JSON.parse(raw));
    return NextResponse.json({ ok: true, data }, {
      headers: {
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Vercel-CDN-Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (e) {
    throw new Error(
      `Invalid deployment-baked pool volume snapshot: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
}
