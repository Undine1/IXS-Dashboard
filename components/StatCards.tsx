'use client';

import { BlockchainStats } from '@/types';
import { formatValue } from '@/lib/utils';

interface StatCardsProps {
  stats: BlockchainStats;
}

export default function StatCards({ stats }: StatCardsProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
          Total Transactions
        </h3>
        <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {stats.totalTransactions}
        </p>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
          Success Rate
        </h3>
        <p className="text-2xl font-bold text-green-600 dark:text-green-400">
          {stats.successRate.toFixed(1)}%
        </p>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
          Avg Gas Price
        </h3>
        <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
          {formatValue(stats.averageGasPrice)} Gwei
        </p>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
          Total Value
        </h3>
        <p className="text-2xl font-bold text-purple-600 dark:text-purple-400">
          {formatValue(stats.totalValue)} ETH
        </p>
      </div>
    </div>
  );
}
