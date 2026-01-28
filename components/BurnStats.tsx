'use client';


import { useState } from 'react';
import { TokenBurnStats, BurnAddress } from '@/types';
import { formatValue, formatAddress } from '@/lib/utils';





interface BurnStatsProps {
  stats: TokenBurnStats;
  tokenSymbol?: string;
}

export default function BurnStats({ stats, tokenSymbol = 'IXS' }: BurnStatsProps) {
  const ethTokenAddress = process.env.NEXT_PUBLIC_ETH_TOKEN_ADDRESS || '';
  const polygonTokenAddress = process.env.NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS || '';
  const baseTokenAddress = process.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS || '';

  // Guard against undefined or empty burnAddresses
  if (!stats || !Array.isArray(stats.burnAddresses) || stats.burnAddresses.length === 0) {
    return (
      <div className="p-6 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-700">
        <p>No burn statistics available yet</p>
      </div>
    );
  }

  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-6">
      {/* Dropdown Card */}
      <div className="rounded-lg shadow-lg border border-red-200 dark:border-red-700 bg-gradient-to-br from-red-50 to-pink-50 dark:from-red-900 dark:to-pink-900">
        <button
          className="w-full flex items-center justify-between p-8 focus:outline-none"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span>
            <h2 className="text-lg font-semibold text-red-900 dark:text-red-100 mb-2">Total Tokens Burned</h2>
            <p className="text-4xl font-bold text-red-700 dark:text-red-300">{formatValue(stats.totalBurned)}</p>
          </span>
          <svg
            className={`w-6 h-6 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {open && (
          <div className="p-6 pt-0">
            {/* Burn Addresses Table */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
              <div className="px-6 py-4 bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-600">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Burn Addresses</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100"></th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">Network</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">Address</th>
                      <th className="px-6 py-3 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">Balance ({tokenSymbol})</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-600">
                    {stats.burnAddresses.map((burn) => {
                      let networkLabel = '';
                      let tokenAddress = '';
                      let explorerUrl = '';
                      let badgeClass = '';
                      if (burn.network === 'ethereum') {
                        networkLabel = 'Ethereum';
                        tokenAddress = ethTokenAddress;
                        explorerUrl = `https://etherscan.io/token/${tokenAddress}?a=${burn.address}`;
                        badgeClass = 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
                      } else if (burn.network === 'polygon') {
                        networkLabel = 'Polygon';
                        tokenAddress = polygonTokenAddress;
                        explorerUrl = `https://polygonscan.com/token/${tokenAddress}?a=${burn.address}`;
                        badgeClass = 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200';
                      } else if (burn.network === 'base') {
                        networkLabel = 'Base';
                        tokenAddress = baseTokenAddress;
                        explorerUrl = `https://basescan.org/token/${tokenAddress}?a=${burn.address}`;
                        badgeClass = 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
                      }

                      return (
                        <tr key={`${burn.network}-${burn.address}`} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                          <td className="px-6 py-4 text-sm font-medium text-gray-900 dark:text-gray-100"></td>
                          <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">
                            <span className={`px-2 py-1 rounded text-xs font-semibold ${badgeClass}`}>{networkLabel}</span>
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
                <div className="text-center py-8 text-gray-500 dark:text-gray-400">No burn addresses configured</div>
              )}
            </div>
          </div>
        )}
      </div>
      {/* TVL Dropdown */}
      <TVLDropMenu />
      {/* Last Updated */}
      <p className="text-xs text-gray-500 dark:text-gray-400 text-right">
        Last updated: {new Date(stats.lastUpdated).toLocaleString()}
      </p>
    </div>
  );

}

function TVLDropMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg shadow-lg border border-blue-200 dark:border-blue-700 bg-gradient-to-br from-blue-50 to-cyan-50 dark:from-blue-900 dark:to-cyan-900 mb-4">
      <button
        className="w-full flex items-center justify-between p-8 focus:outline-none"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>
          <h2 className="text-lg font-semibold text-blue-900 dark:text-blue-100 mb-2">TVL</h2>
        </span>
        <svg
          className={`w-6 h-6 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="p-6 pt-0">
          <div className="text-lg font-semibold text-blue-900 dark:text-blue-100">
            $88.45m - Verified by{' '}
            <a
              href="https://app.rwa.io/project/ixs-finance?tab=Project-Token"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline"
            >
              RWA.IO
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
