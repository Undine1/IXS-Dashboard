/**
 * Hourly snapshot of the on-demand chain reads: pool reserve valuations (TVL)
 * and burn-address balances. Reads are grouped into one Multicall3 eth_call per
 * configured chain, with individual RPC fallback if a whole batch fails.
 * Running this in CI lets the Vercel routes serve
 * a deployment-baked file instead of fanning out RPC calls per request — the
 * live RPC path in lib/poolsService + lib/burnStatsService remains only as a
 * fallback (missing/stale snapshot, ?fresh=1, ?debug=1).
 *
 * Sections are merged last-known-good: a section that failed to refresh keeps
 * its previous data in the file, and the script exits non-zero so the
 * workflow surfaces the failure without serving worse data.
 *
 * Run: npm run update:onchain-snapshot   (loads .env.local locally; CI env)
 */
import fs from 'fs';
import path from 'path';

// Minimal .env.local loader (parity with the other updater scripts).
function loadEnvLocal(): void {
  try {
    const envFile = path.join(__dirname, '..', '.env.local');
    if (!fs.existsSync(envFile)) return;
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
      }
    }
  } catch (error) {
    console.warn('[onchain-snapshot] Unable to load .env.local:', (error as Error)?.message);
  }
}

loadEnvLocal();

// Token addresses default to the canonical IXS contracts (parity with
// update_holder_rankings.js) so the script works without env configuration.
const ENV_DEFAULTS: Record<string, string> = {
  NEXT_PUBLIC_ETH_TOKEN_ADDRESS: '0x73d7c860998ca3c01ce8c808f5577d94d545d1b4',
  NEXT_PUBLIC_BASE_TOKEN_ADDRESS: '0xfe550bffb51eb645ea3b324d772a19ac449e92c5',
  NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS: '0x1ba17c639bdaecd8dc4aac37df062d17ee43a1b8',
};
for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
  if (!String(process.env[key] || '').trim()) {
    process.env[key] = value;
  }
}

const SNAPSHOT_FILE = path.join(__dirname, '..', 'public', 'data', 'onchain_snapshot.json');

type SnapshotSection = { generatedAt: string; data: unknown };
type Snapshot = { pools?: SnapshotSection; burnStats?: SnapshotSection };
type FreshSection = { data: unknown; healthy: boolean };

export function mergeSnapshotSections(
  previous: Snapshot | null,
  fresh: { pools: FreshSection; burnStats: FreshSection },
  generatedAt: string,
): Snapshot {
  return {
    pools: fresh.pools.healthy ? { generatedAt, data: fresh.pools.data } : previous?.pools,
    burnStats: fresh.burnStats.healthy ? { generatedAt, data: fresh.burnStats.data } : previous?.burnStats,
  };
}

function readPreviousSnapshot(): Snapshot | null {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')) as Snapshot;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // Dynamic imports so the env defaults above apply before the services read
  // their module-level configuration.
  const { computePoolsBody } = await import('../lib/poolsService');
  const { computeBurnStats } = await import('../lib/burnStatsService');
  const { prefetchSnapshotRpcReads } = await import('../lib/snapshotRpcBatch');

  const prefetchedReads = await prefetchSnapshotRpcReads();
  const poolsResult = await computePoolsBody({ prefetchedReads });
  const burnResult = await computeBurnStats({ prefetchedReads });

  const generatedAt = new Date().toISOString();
  const previous = readPreviousSnapshot();
  const next = mergeSnapshotSections(
    previous,
    {
      pools: { data: poolsResult.body, healthy: poolsResult.healthy },
      burnStats: { data: burnResult.payload, healthy: burnResult.healthy },
    },
    generatedAt,
  );

  fs.writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(next, null, 2)}\n`);

  console.log(
    `[onchain-snapshot] pools: ${poolsResult.healthy ? 'refreshed' : 'KEPT PREVIOUS'} (${poolsResult.body.pools.length} pools), ` +
      `burnStats: ${burnResult.healthy ? 'refreshed' : 'KEPT PREVIOUS'}. Wrote ${SNAPSHOT_FILE}`,
  );

  const failures: string[] = [];
  if (!poolsResult.healthy) {
    failures.push(`pools section unhealthy: ${(poolsResult.body.warnings || ['unknown']).join(' | ')}`);
  }
  if (!burnResult.healthy) {
    failures.push('burnStats section unhealthy: missing or null balances');
  }
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`[onchain-snapshot] ${failure}`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[onchain-snapshot] failed:', error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
