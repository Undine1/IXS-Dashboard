'use client';

import { useEffect, useState } from 'react';
import BurnStats from '@/components/BurnStats';
import { fetchTokenBurnStatsFromAPI } from '@/lib/clientBurnService';
import { TokenBurnStats } from '@/types';

export default function Dashboard() {
  const [burnStats, setBurnStats] = useState<TokenBurnStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        // Fetch token burn stats via secure server-side API
        const burns = await fetchTokenBurnStatsFromAPI();
        console.log('[Dashboard] Burn stats loaded:', burns);
        setBurnStats(burns);
      } catch (error) {
        console.error('[Dashboard] Failed to load data:', error);
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
    <main className="min-h-screen bg-gray-100 dark:bg-gray-900 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
            IXS Dashboard
          </h1>
          {/* Removed burn tracking subtitle as requested */}
        </div>

        {loading ? (
          <div className="p-8 bg-white dark:bg-gray-800 rounded-lg shadow text-center">
            <p className="text-gray-600 dark:text-gray-400">Loading statistics...</p>
          </div>
        ) : burnStats && burnStats.burnAddresses.length > 0 ? (
          <BurnStats stats={burnStats} tokenSymbol={process.env.NEXT_PUBLIC_TOKEN_SYMBOL} />
        ) : (
          <div className="p-8 bg-yellow-50 dark:bg-yellow-900 border border-yellow-200 dark:border-yellow-700 rounded-lg">
            <p className="text-yellow-800 dark:text-yellow-200">No burn statistics available</p>
          </div>
        )}
      </div>
    </main>
  );
}
