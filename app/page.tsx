'use client';

import { useEffect, useState } from 'react';
import TransactionList from '@/components/TransactionList';
import TransactionChart from '@/components/TransactionChart';
import StatCards from '@/components/StatCards';
import Filter from '@/components/Filter';
import BurnStats from '@/components/BurnStats';
import { fetchLatestTransactions, getBlockchainStats } from '@/lib/blockchainService';
import { fetchTokenBurnStatsFromAPI } from '@/lib/clientBurnService';
import { useTransactionStore } from '@/lib/store';
import { Transaction, BlockchainStats, FilterOptions, TokenBurnStats } from '@/types';

export default function Dashboard() {
  const [stats, setStats] = useState<BlockchainStats | null>(null);
  const [burnStats, setBurnStats] = useState<TokenBurnStats | null>(null);
  const [loading, setLoading] = useState(false);
  const { transactions, filters, setTransactions, setFilters, getFilteredTransactions } =
    useTransactionStore();

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        // Fetch token burn stats via secure server-side API
        const burns = await fetchTokenBurnStatsFromAPI();
        console.log('[Dashboard] Burn stats loaded:', burns);
        setBurnStats(burns);

        // Fetch mock transactions for demo
        const txs = await fetchLatestTransactions(undefined, 20);
        console.log('[Dashboard] Transactions loaded:', txs.length);
        setTransactions(txs);

        // Calculate stats
        const blockchainStats = await getBlockchainStats(txs);
        console.log('[Dashboard] Stats calculated:', blockchainStats);
        setStats(blockchainStats);
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
  }, [setTransactions]);

  const handleFilterChange = (newFilters: FilterOptions) => {
    setFilters(newFilters);
  };

  const filteredTransactions = getFilteredTransactions();

  return (
    <main className="min-h-screen bg-gray-100 dark:bg-gray-900 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
            IXS Dashboard
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Token burn tracking across Ethereum and Polygon
          </p>
        </div>

        {/* Loading State */}
        {loading && transactions.length === 0 && (
          <div className="text-center py-12">
            <div className="inline-block animate-spin">
              <div className="border-4 border-gray-200 border-t-blue-600 rounded-full h-12 w-12"></div>
            </div>
            <p className="mt-4 text-gray-600 dark:text-gray-400">Loading blockchain data...</p>
          </div>
        )}

        {!loading && burnStats && burnStats.burnAddresses.length > 0 && (
          <>
            {/* Burn Stats - Featured at Top */}
            <div className="mb-8">
              <BurnStats stats={burnStats} tokenSymbol="IXS" />
            </div>

            {transactions.length > 0 && (
              <>
                {/* Stats Cards */}
                <div className="mb-8">
                  <StatCards stats={stats!} />
                </div>

                {/* Filter */}
                <Filter onFilterChange={handleFilterChange} />

                {/* Chart */}
                <div className="mb-8">
                  <TransactionChart transactions={transactions} />
                </div>

                {/* Transaction List */}
                <div>
                  <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
                    Recent Transactions ({filteredTransactions.length})
                  </h2>
                  <TransactionList transactions={filteredTransactions} />
                </div>
              </>
            )}
          </>
        )}

        {!loading && (!burnStats || burnStats.burnAddresses.length === 0) && (
          <div className="bg-yellow-50 dark:bg-yellow-900 border border-yellow-200 dark:border-yellow-700 rounded-lg p-6 text-center">
            <p className="text-yellow-800 dark:text-yellow-200">
              No blockchain data available. Please ensure your Etherscan API key is configured in
              the environment variables.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
