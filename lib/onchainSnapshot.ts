import fs from 'fs';
import path from 'path';
import type { PoolsResponseBody } from './poolsService';
import type { BurnStatsApiResponse } from './burnStatsService';

// Reader for the hourly on-chain snapshot written by
// scripts/update_onchain_snapshot.ts in CI. Like the other committed data
// files, the snapshot is immutable within a deployment — refreshed data
// arrives via a new deploy — so the parsed file is memoized per instance.

export type OnchainSnapshotSection<T> = {
  generatedAt: string;
  data: T;
};

export type OnchainSnapshot = {
  pools?: OnchainSnapshotSection<PoolsResponseBody>;
  burnStats?: OnchainSnapshotSection<BurnStatsApiResponse>;
};

// If the pipeline stalls, sections older than this are ignored so the routes
// degrade to live RPC reads instead of pinning outdated numbers forever.
const SNAPSHOT_MAX_AGE_MS =
  Math.max(1, Number(process.env.ONCHAIN_SNAPSHOT_MAX_AGE_HOURS || 6)) * 3600_000;

let cached: OnchainSnapshot | null | undefined;

function readSnapshotFile(): OnchainSnapshot | null {
  try {
    const file = path.join(process.cwd(), 'public', 'data', 'onchain_snapshot.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')) as OnchainSnapshot;
  } catch {
    return null;
  }
}

export function readSnapshotSection<K extends keyof OnchainSnapshot>(
  key: K,
): NonNullable<OnchainSnapshot[K]> | null {
  if (cached === undefined) {
    cached = readSnapshotFile();
  }

  const section = cached?.[key];
  if (!section || typeof section !== 'object') return null;

  const generatedAtMs = Date.parse(String(section.generatedAt || ''));
  if (!Number.isFinite(generatedAtMs)) return null;
  if (Date.now() - generatedAtMs > SNAPSHOT_MAX_AGE_MS) return null;

  return section as NonNullable<OnchainSnapshot[K]>;
}
