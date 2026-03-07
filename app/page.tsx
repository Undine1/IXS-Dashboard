'use client';

import { useEffect, useState } from 'react';
import BurnStats from '@/components/BurnStats';
import { fetchTokenBurnStatsFromAPI } from '@/lib/clientBurnService';
import { Pool, PoolsApiResponse, TokenBurnStats } from '@/types';

interface SyncStatusResponse {
  ok?: boolean;
  lastDeploymentCompletedAt?: string | null;
}

export default function Dashboard() {
  const [burnStats, setBurnStats] = useState<TokenBurnStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [pools, setPools] = useState<Pool[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [lastDeploymentCompletedAt, setLastDeploymentCompletedAt] = useState<string | null>(null);

  const hasBurnData = Boolean(burnStats && burnStats.burnAddresses.length > 0);

  const burnEngineStatus = loading
    ? 'Syncing'
    : hasBurnData && burnStats?.totalBurned !== null
      ? 'Online'
      : 'Degraded';

  const poolIndexerStatus = loading
    ? 'Syncing'
    : pools.length > 0 && warnings.length === 0
      ? 'Healthy'
      : pools.length > 0
        ? 'Warning'
        : 'Offline';

  const lastSync = lastDeploymentCompletedAt
    ? new Date(lastDeploymentCompletedAt).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    : 'N/A';

  const statusTone = (status: string): string => {
    if (status === 'Online' || status === 'Healthy') return 'bg-emerald-400';
    if (status === 'Syncing') return 'bg-cyan-300 animate-pulse';
    if (status === 'Warning' || status === 'Degraded') return 'bg-amber-300';
    return 'bg-rose-300';
  };

  useEffect(() => {
    if (!loading) return;

    const interval = setInterval(() => {
      setLoadingProgress((previous) => {
        if (previous >= 92) return previous;
        if (previous < 40) return previous + 6;
        if (previous < 70) return previous + 3;
        return previous + 1;
      });
    }, 180);

    return () => clearInterval(interval);
  }, [loading]);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      setLoadingProgress(8);
      try {
        // Fetch burn stats and pools in parallel so the page stays in
        // "Loading statistics..." until both are available.
        const burnsPromise = fetchTokenBurnStatsFromAPI().then((result) => {
          setLoadingProgress((previous) => Math.max(previous, 58));
          return result;
        });
        const poolsPromise: Promise<PoolsApiResponse | null> = fetch('/api/pools')
          .then(async (r) => (r.ok ? ((await r.json()) as PoolsApiResponse) : null))
          .then((result) => {
            setLoadingProgress((previous) => Math.max(previous, 82));
            return result;
          })
          .catch(() => {
            setLoadingProgress((previous) => Math.max(previous, 82));
            return null;
          });
        const syncStatusPromise: Promise<SyncStatusResponse | null> = fetch('/api/syncStatus', { cache: 'no-store' })
          .then(async (r) => (r.ok ? ((await r.json()) as SyncStatusResponse) : null))
          .then((result) => {
            setLoadingProgress((previous) => Math.max(previous, 92));
            return result;
          })
          .catch(() => {
            setLoadingProgress((previous) => Math.max(previous, 92));
            return null;
          });

        const [burnsResult, poolsResult, syncStatusResult] = await Promise.all([
          burnsPromise,
          poolsPromise,
          syncStatusPromise,
        ]);

        if (burnsResult) {
          setBurnStats(burnsResult);
        }

        if (poolsResult?.pools) {
          setPools(poolsResult.pools);
          setWarnings(poolsResult.warnings || []);
        } else {
          setPools([]);
          setWarnings([]);
        }

        if (syncStatusResult?.ok) {
          setLastDeploymentCompletedAt(syncStatusResult.lastDeploymentCompletedAt || null);
        } else {
          setLastDeploymentCompletedAt(null);
        }
      } catch (error) {
        console.error('[Dashboard] Failed to load data:', error);
        setPools([]);
        setWarnings([]);
        setLastDeploymentCompletedAt(null);
      } finally {
        setLoadingProgress(100);
        await new Promise((resolve) => setTimeout(resolve, 140));
        setLoading(false);
      }
    };

    loadData();
    // Refresh every 1 hour
    const interval = setInterval(loadData, 3600000);
    return () => clearInterval(interval);
  }, []);

  return (
    <main className="min-h-screen bg-slate-50 dark:bg-[#0B1120] p-4 md:p-8 transition-colors duration-300">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8 relative overflow-hidden rounded-3xl border border-slate-200/80 dark:border-slate-700/60 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950 text-white shadow-[0_20px_70px_-35px_rgba(2,6,23,0.9)]">
          <div className="absolute inset-0 opacity-25 [background-image:linear-gradient(to_right,rgba(148,163,184,0.25)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.25)_1px,transparent_1px)] [background-size:32px_32px]" />
          <div className="absolute -top-20 -left-14 h-72 w-72 rounded-full bg-cyan-400/20 blur-3xl" />
          <div className="absolute -bottom-24 -right-8 h-72 w-72 rounded-full bg-emerald-400/15 blur-3xl" />

          <div className="relative z-10 grid gap-6 p-6 md:p-8 lg:grid-cols-[1.25fr_1fr] lg:items-end">
            <div>
              <h1 className="text-3xl font-semibold leading-tight md:text-4xl">IXS Statistics</h1>
              <p className="mt-3 max-w-2xl text-sm text-slate-200/85 md:text-base">
                Burn telemetry, cross-chain liquidity, and platform volume in one view.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
              <div className="rounded-2xl border border-white/15 bg-white/6 px-4 py-3 backdrop-blur-sm">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-300">Burn Engine</p>
                <div className="mt-2 flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${statusTone(burnEngineStatus)}`} />
                  <span className="text-sm font-semibold text-white">{burnEngineStatus}</span>
                </div>
              </div>

              <div className="rounded-2xl border border-white/15 bg-white/6 px-4 py-3 backdrop-blur-sm">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-300">Pool Indexer</p>
                <div className="mt-2 flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${statusTone(poolIndexerStatus)}`} />
                  <span className="text-sm font-semibold text-white">{poolIndexerStatus}</span>
                </div>
              </div>

              <div className="rounded-2xl border border-white/15 bg-white/6 px-4 py-3 backdrop-blur-sm">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-300">Last Sync</p>
                <p className="mt-2 text-sm font-semibold text-white">{loading ? 'Syncing...' : lastSync}</p>
              </div>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="py-8 md:py-10">
            <div className="mx-auto w-full max-w-2xl">
              <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                <span>Updating Statistics</span>
                <span>{Math.round(loadingProgress)}%</span>
              </div>
              <div className="mt-3 h-4 w-full rounded-md border border-slate-300/90 bg-transparent p-0.5 dark:border-slate-600/90">
                <div
                  className="h-full rounded-sm bg-slate-700 transition-[width] duration-200 ease-out dark:bg-slate-200"
                  style={{ width: `${Math.max(0, Math.min(100, loadingProgress))}%` }}
                />
              </div>
            </div>
          </div>
        ) : burnStats && burnStats.burnAddresses.length > 0 ? (
          <BurnStats stats={burnStats} tokenSymbol={process.env.NEXT_PUBLIC_TOKEN_SYMBOL} pools={pools} warnings={warnings} />
        ) : (
          <div className="p-8 bg-yellow-50 dark:bg-yellow-900 border border-yellow-200 dark:border-yellow-700 rounded-lg">
            <p className="text-yellow-800 dark:text-yellow-200">No burn statistics available</p>
          </div>
        )}
      </div>
    </main>
  );
}
