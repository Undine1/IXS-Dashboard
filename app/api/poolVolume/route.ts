import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

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

function normalizePoolVolume(raw: unknown): { pools: Record<string, PoolVolumeEntry>; lastUpdated: number } {
  if (!raw || typeof raw !== 'object') {
    return { pools: {}, lastUpdated: Date.now() };
  }

  const source = raw as Record<string, unknown>;
  const normalized: Record<string, PoolVolumeEntry> = {};

  const rawPools = source.pools;
  if (rawPools && typeof rawPools === 'object' && !Array.isArray(rawPools)) {
    for (const [address, entry] of Object.entries(rawPools)) {
      normalized[address.toLowerCase()] = (entry as PoolVolumeEntry) || {};
    }
  }

  // Backward compatibility for legacy flat-object formats keyed by pool address.
  for (const [key, value] of Object.entries(source)) {
    if (!isAddressKey(key)) continue;
    normalized[key.toLowerCase()] = (value as PoolVolumeEntry) || {};
  }

  const lastUpdatedRaw = source.lastUpdated;
  const lastUpdated = typeof lastUpdatedRaw === 'number'
    ? lastUpdatedRaw
    : Number(lastUpdatedRaw) || Date.now();

  return { pools: normalized, lastUpdated };
}

export async function GET() {
  try {
    const file = path.join(process.cwd(), 'public', 'data', 'pool_volume.json');
    const raw = fs.readFileSync(file, 'utf8');
    const data = normalizePoolVolume(JSON.parse(raw));
    return NextResponse.json(
      { ok: true, data },
      {
        headers: {
          // The snapshot file is immutable within a deployment (refreshed data
          // arrives via a new deploy, which purges the CDN cache), so a long
          // s-maxage is loss-free and lets the edge absorb page loads.
          'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
        },
      },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e) },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
