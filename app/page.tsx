'use client';

import { useEffect, useState } from 'react';
import BurnStats from '@/components/BurnStats';
import ThemeToggle from '@/components/ThemeToggle';
import { fetchTokenBurnStatsFromAPI } from '@/lib/clientBurnService';
import { TokenBurnStats } from '@/types';

export default function Dashboard() {
  const [burnStats, setBurnStats] = useState<TokenBurnStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [pools, setPools] = useState<any[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        // Fetch burn stats and pools in parallel so the page stays in
        // "Loading statistics..." until both are available.
        const burnsPromise = fetchTokenBurnStatsFromAPI();
        const poolsPromise = fetch('/api/pools').then((r) => (r.ok ? r.json() : null)).catch(() => null);

        const [burnsResult, poolsResult]: any = await Promise.all([burnsPromise, poolsPromise]);

        if (burnsResult) {
          setBurnStats(burnsResult);
        }

        if (poolsResult && poolsResult.pools) {
          setPools(poolsResult.pools || []);
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
        <div className="mb-8 flex justify-between items-center">
          <div>
            <h1 className="text-4xl font-bold mb-2 bg-clip-text text-transparent bg-gradient-to-r from-teal-500 to-cyan-500 dark:from-teal-400 dark:to-cyan-400">
              IXS Dashboard
            </h1>
          </div>
          <ThemeToggle />
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
