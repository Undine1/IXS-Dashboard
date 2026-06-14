import { promises as fs } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// branch/status filters keep the 20-entry page from being crowded out by
// unrelated runs (CodeQL, PRs), so the data workflows are always in range.
const GITHUB_RUNS_URL =
  'https://api.github.com/repos/Undine1/IXS-Dashboard/actions/runs?branch=main&status=success&per_page=20';
const HOLDER_RANKINGS_FILE = path.join(process.cwd(), 'public', 'data', 'holder_rankings.json');
const POOL_VOLUME_FILE = path.join(process.cwd(), 'public', 'data', 'pool_volume.json');
// 'Update Dashboard Data' is the current combined workflow; the two legacy
// names cover runs from before the workflows were merged.
const TARGET_WORKFLOWS = new Set(['Update Dashboard Data', 'Update Holder Rankings', 'Update Pool Volume']);
const DEFAULT_CACHE_TTL_SECONDS = 300;

type SyncStatusPayload = {
  ok: true;
  lastDeploymentCompletedAt: string | null;
  source: 'github-actions' | 'snapshot' | 'unavailable';
};

type WorkflowRun = {
  name?: unknown;
  conclusion?: unknown;
  updated_at?: unknown;
  head_branch?: unknown;
};

let cachedPayload: SyncStatusPayload | null = null;
let cachedAtMs = 0;
let inFlightRead: Promise<SyncStatusPayload> | null = null;
let warnedMissingToken = false;

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

function toIsoString(value: number | null): string | null {
  return value && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getLatestWorkflowCompletion(): Promise<string | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'IXS-Dashboard-sync-status',
  };

  const githubToken = String(
    process.env.GH_PAT || process.env.GITHUB_TOKEN || process.env.GITHUB_API_TOKEN || '',
  ).trim();
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  } else if (!warnedMissingToken) {
    // Unauthenticated GitHub API is limited to 60 req/hr/IP and will rate-limit
    // under any real traffic, silently degrading this route to the snapshot
    // fallback. Surface it once so it's diagnosable in logs.
    warnedMissingToken = true;
    console.warn(
      '[syncStatus] No GH_PAT/GITHUB_TOKEN configured; using unauthenticated GitHub API (60 req/hr/IP).',
    );
  }

  const response = await fetch(GITHUB_RUNS_URL, {
    headers,
    cache: 'no-store',
  });

  if (!response.ok) {
    const rateLimited =
      response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0';
    throw new Error(
      `GitHub Actions API failed with ${response.status} ${response.statusText}${
        rateLimited ? ' (rate limit exhausted — set GH_PAT to raise the quota)' : ''
      }`,
    );
  }

  const payload = (await response.json()) as { workflow_runs?: WorkflowRun[] };
  const runs = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];

  let latestMs: number | null = null;

  for (const run of runs) {
    const name = typeof run.name === 'string' ? run.name : '';
    const conclusion = typeof run.conclusion === 'string' ? run.conclusion : '';
    const branch = typeof run.head_branch === 'string' ? run.head_branch : '';
    if (!TARGET_WORKFLOWS.has(name) || conclusion !== 'success' || branch !== 'main') {
      continue;
    }

    const updatedAtMs = toEpochMs(run.updated_at);
    if (!updatedAtMs) continue;
    latestMs = latestMs == null ? updatedAtMs : Math.max(latestMs, updatedAtMs);
  }

  return toIsoString(latestMs);
}

function collectPoolVolumeTimestamps(source: unknown): number[] {
  if (!source || typeof source !== 'object') return [];

  const payload = source as Record<string, unknown>;
  const timestamps: number[] = [];

  const topLevelLastUpdated = toEpochMs(payload.lastUpdated);
  if (topLevelLastUpdated) {
    timestamps.push(topLevelLastUpdated);
  }

  const poolsSource =
    payload.pools && typeof payload.pools === 'object' && !Array.isArray(payload.pools)
      ? (payload.pools as Record<string, unknown>)
      : payload;

  for (const entry of Object.values(poolsSource)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const lastUpdated = toEpochMs((entry as Record<string, unknown>).lastUpdated);
    if (lastUpdated) {
      timestamps.push(lastUpdated);
    }
  }

  return timestamps;
}

async function getSnapshotFallback(): Promise<string | null> {
  const [holderSnapshot, poolSnapshot] = await Promise.all([
    readJson(HOLDER_RANKINGS_FILE),
    readJson(POOL_VOLUME_FILE),
  ]);

  const timestamps: number[] = [];

  if (holderSnapshot && typeof holderSnapshot === 'object') {
    const lastRefreshed = toEpochMs((holderSnapshot as Record<string, unknown>).lastRefreshed);
    if (lastRefreshed) {
      timestamps.push(lastRefreshed);
    }
  }

  timestamps.push(...collectPoolVolumeTimestamps(poolSnapshot));

  if (!timestamps.length) return null;
  return toIsoString(Math.max(...timestamps));
}

async function readSyncStatus(): Promise<SyncStatusPayload> {
  try {
    const lastDeploymentCompletedAt = await getLatestWorkflowCompletion();
    if (lastDeploymentCompletedAt) {
      return {
        ok: true,
        lastDeploymentCompletedAt,
        source: 'github-actions',
      };
    }
  } catch {
    // Fall back to local snapshot timestamps.
  }

  const snapshotTimestamp = await getSnapshotFallback();
  if (snapshotTimestamp) {
    return {
      ok: true,
      lastDeploymentCompletedAt: snapshotTimestamp,
      source: 'snapshot',
    };
  }

  return {
    ok: true,
    lastDeploymentCompletedAt: null,
    source: 'unavailable',
  };
}

// CDN TTL matches the in-memory TTL, so the staleness bound is unchanged but
// repeat requests dedupe at the edge instead of invoking the function (and
// hitting the GitHub API) once per warm instance.
const CACHE_CONTROL = `public, max-age=0, s-maxage=${DEFAULT_CACHE_TTL_SECONDS}, stale-while-revalidate=${DEFAULT_CACHE_TTL_SECONDS * 2}`;

export async function GET() {
  const cacheTtlMs = DEFAULT_CACHE_TTL_SECONDS * 1000;
  const now = Date.now();

  if (cachedPayload && now - cachedAtMs < cacheTtlMs) {
    return NextResponse.json(cachedPayload, {
      headers: {
        'Cache-Control': CACHE_CONTROL,
      },
    });
  }

  if (!inFlightRead) {
    inFlightRead = readSyncStatus();
  }

  try {
    const payload = await inFlightRead;
    cachedPayload = payload;
    cachedAtMs = Date.now();
    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': CACHE_CONTROL,
      },
    });
  } finally {
    inFlightRead = null;
  }
}
