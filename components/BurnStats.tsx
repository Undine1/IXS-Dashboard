'use client';

import { TokenBurnStats, BurnAddress } from '@/types';
import { formatValue, formatAddress } from '@/lib/utils';

interface BurnStatsProps {
  stats: TokenBurnStats;
  tokenSymbol?: string;
}

export default function BurnStats({ stats, tokenSymbol = 'IXS' }: BurnStatsProps) {
  const ethTokenAddress = process.env.NEXT_PUBLIC_ETH_TOKEN_ADDRESS || '';
  const polygonTokenAddress = process.env.NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS || '';

  return (
    <div className="space-y-6">
      {/* Total Burned Card */}
      <div className="bg-gradient-to-br from-red-50 to-pink-50 dark:from-red-900 dark:to-pink-900 rounded-lg shadow-lg p-8 border border-red-200 dark:border-red-700">
        <h2 className="text-lg font-semibold text-red-900 dark:text-red-100 mb-2">
          Total Tokens Burned
        </h2>
        <p className="text-4xl font-bold text-red-700 dark:text-red-300">
          {formatValue(stats.totalBurned)}
        </p>
        <p className="text-red-600 dark:text-red-400 mt-1">
          {tokenSymbol} Tokens Permanently Removed
        </p>
      </div>

      {/* Burn Addresses Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
        <div className="px-6 py-4 bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-600">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Burn Addresses
          </h3>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Label
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Network
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Address
                </th>
                <th className="px-6 py-3 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Balance ({tokenSymbol})
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-600">
              {stats.burnAddresses.map((burn) => {
                const networkLabel = burn.network === 'ethereum' ? 'Ethereum' : 'Polygon';
                const tokenAddress = burn.network === 'ethereum' ? ethTokenAddress : polygonTokenAddress;
                const explorerUrl =
                  burn.network === 'ethereum'
                    ? `https://etherscan.io/token/${tokenAddress}?a=${burn.address}`
                    : `https://polygonscan.com/token/${tokenAddress}?a=${burn.address}`;

                return (
                  <tr key={`${burn.network}-${burn.address}`} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                    <td className="px-6 py-4 text-sm font-medium text-gray-900 dark:text-gray-100">
                      {burn.label}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">
                      <span className={`px-2 py-1 rounded text-xs font-semibold ${
                        burn.network === 'ethereum'
                          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                          : 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
                      }`}>
                        {networkLabel}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm font-mono">
                      <a
                        href={explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline"
                      >
                        {formatAddress(burn.address)}
                      </a>
                    </td>
                    <td className="px-6 py-4 text-sm text-right font-semibold text-red-600 dark:text-red-400">
                      {formatValue(burn.balance)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {stats.burnAddresses.length === 0 && (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            No burn addresses configured
          </div>
        )}
      </div>

      {/* Last Updated */}
      <p className="text-xs text-gray-500 dark:text-gray-400 text-right">
        Last updated: {new Date(stats.lastUpdated).toLocaleString()}
      </p>
    </div>
  );
}
