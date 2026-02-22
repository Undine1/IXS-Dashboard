'use client';

import { useEffect, useState } from 'react';
import BurnStats from '@/components/BurnStats';
import { fetchTokenBurnStatsFromAPI } from '@/lib/clientBurnService';
import { Pool, PoolsApiResponse, TokenBurnStats } from '@/types';

export default function Dashboard() {
  const [burnStats, setBurnStats] = useState<TokenBurnStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [pools, setPools] = useState<Pool[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        // Fetch burn stats and pools in parallel so the page stays in
        // "Loading statistics..." until both are available.
        const burnsPromise = fetchTokenBurnStatsFromAPI();
        const poolsPromise: Promise<PoolsApiResponse | null> = fetch('/api/pools')
          .then(async (r) => (r.ok ? ((await r.json()) as PoolsApiResponse) : null))
          .catch(() => null);

        const [burnsResult, poolsResult] = await Promise.all([burnsPromise, poolsPromise]);

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
      } catch (error) {
        console.error('[Dashboard] Failed to load data:', error);
        setPools([]);
        setWarnings([]);
      } finally {
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
        <div className="mb-8 flex justify-center">
          <picture className="w-full max-w-4xl">
            <img src="/images/banner.svg" alt="IXS Dashboard" className="w-full h-auto" />
          </picture>
          <h1 className="sr-only">IXS Dashboard</h1>
        </div>

        {loading ? (
          <div className="p-8 bg-white dark:bg-gray-800 rounded-lg shadow text-center">
            <p className="text-gray-600 dark:text-gray-400">Loading statistics...</p>
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
