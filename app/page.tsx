'use client';

import { useEffect, useState } from 'react';
import BurnStats from '@/components/BurnStats';
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
          <div className="flex flex-col items-start text-teal-700 dark:text-teal-400 text-[10px] font-semibold bg-teal-50 dark:bg-teal-900/20 px-1.5 py-0.5 rounded gap-0.5">
            <div className="flex items-center">
              <svg className="w-2.5 h-2.5 mr-0.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-7.071 7.071a1 1 0 01-1.414 0l-3.182-3.182a1 1 0 011.414-1.414L9 11.586l6.293-6.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
              Original max supply: 180m
            </div>
            <div className="flex items-center">
              <svg className="w-2.5 h-2.5 mr-0.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-7.071 7.071a1 1 0 01-1.414 0l-3.182-3.182a1 1 0 011.414-1.414L9 11.586l6.293-6.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
              Fully circulating
            </div>
          </div>
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
