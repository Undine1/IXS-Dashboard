"use client";

import React, { useState, useEffect, Fragment, useMemo } from 'react';
import { TokenBurnStats, BurnAddress } from '@/types';
import { formatValue, formatAddress, formatUsd } from '@/lib/utils';
import { PRIVATE_ENTRY as DEFAULT_PRIVATE_ENTRY, PUBLIC_DEALS as DEFAULT_PUBLIC_DEALS, TYPE_LABELS } from '@/lib/tvlConfig';





interface BurnStatsProps {
  stats: TokenBurnStats;
  tokenSymbol?: string;
  pools?: any[];
  warnings?: string[];
}

export default function BurnStats({ stats, tokenSymbol = 'IXS', pools = [], warnings = [] }: BurnStatsProps) {
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
  // `pools` and `warnings` are provided by parent `Dashboard` so the
  // overall page can remain in the loading state until pools finish
  // loading. This avoids rendering the TVL section partially while the
  // page already appears loaded.

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
                      <th className="px-3 py-3 text-center text-sm font-semibold text-gray-900 dark:text-gray-100">Network</th>
                      <th className="px-6 py-3 text-center text-sm font-semibold text-gray-900 dark:text-gray-100">Address</th>
                      <th className="px-6 py-3 text-center text-sm font-semibold text-gray-900 dark:text-gray-100">Balance ({tokenSymbol})</th>
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
                                <img
                                  src={`/images/chains/${burn.network}.png`}
                                  alt={networkLabel}
                                  title={networkLabel}
                                  className="w-6 h-6 object-contain"
                                />
                              </td>
                          <td className="px-6 py-4 text-sm font-mono text-center">
                            <a
                              href={explorerUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline"
                            >
                              {formatAddress(burn.address)}
                            </a>
                          </td>
                          <td className="px-6 py-4 text-sm text-center font-semibold text-red-600 dark:text-red-400">
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
      <TVLDropMenu pools={pools} warnings={warnings} />
      {/* Last Updated */}
      <p className="text-xs text-gray-500 dark:text-gray-400 text-right">
        Last updated: {new Date(stats.lastUpdated).toLocaleString()}
      </p>
    </div>
  );

}

function TVLDropMenu({ pools, warnings }: { pools: any[]; warnings?: string[] }) {
  const [open, setOpen] = useState(false);
  const [privateEntry, setPrivateEntry] = useState(DEFAULT_PRIVATE_ENTRY);
  const [publicDeals, setPublicDeals] = useState(DEFAULT_PUBLIC_DEALS);

  useEffect(() => {
    const fetchTvlConfig = async () => {
      try {
        const res = await fetch('/data/tvlConfig.json');
        if (res.ok) {
          const cfg = await res.json();
          if (cfg.privateEntry) setPrivateEntry(cfg.privateEntry);
          if (Array.isArray(cfg.publicDeals)) setPublicDeals(cfg.publicDeals);
        }
      } catch (e) {
        // ignore and keep defaults
      }
    };
    fetchTvlConfig();
  }, []);

  const totalTvl = useMemo(() => {
    const poolSum = (pools || []).reduce((s: number, p: any) => s + (Number(p.value) || 0), 0);
    const publicSum = (publicDeals || []).reduce((s, p) => s + (Number(p.value) || 0), 0);
    return poolSum + Number(privateEntry.value) + publicSum;
  }, [pools, publicDeals, privateEntry]);
  return (
    <div className="rounded-lg shadow-lg border border-blue-200 dark:border-blue-700 bg-gradient-to-br from-blue-50 to-cyan-50 dark:from-blue-900 dark:to-cyan-900 mb-4">
      <button
        className="w-full flex items-center justify-between p-8 focus:outline-none"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>
          <h2 className="text-lg font-semibold text-blue-900 dark:text-blue-100 mb-2">TVL</h2>
          <p className="text-4xl font-bold text-blue-700 dark:text-blue-300">{formatUsd(totalTvl, 0)}</p>
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
      {warnings && warnings.length > 0 && (
        <div className="p-4 bg-yellow-50 border border-yellow-200 text-yellow-800 rounded m-4">
          {warnings.map((w, i) => (
            <div key={i} className="text-sm">{w}</div>
          ))}
        </div>
      )}

      {open && (
        <div className="p-6 pt-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                    Type
                  </th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-600">
                {/* Top summary row for Private deals (label only) */}
                <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                  <td className="px-6 py-4 text-sm font-bold text-gray-900 dark:text-gray-100">Private deals</td>
                  <td className="px-6 py-4 text-sm text-blue-700 dark:text-blue-300">&nbsp;</td>
                </tr>

                {/* Private summary row */}
                <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                  <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100">{privateEntry.label}</td>
                  <td className="px-6 py-4 text-sm text-blue-700 dark:text-blue-300">{formatUsd(privateEntry.value, 0)} - Verified by{' '}
                    <a
                      href={privateEntry.verifiedBy.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline"
                    >
                      {privateEntry.verifiedBy.label}
                    </a>
                  </td>
                </tr>

                {/* Public Deals summary row */}
                <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                  <td className="px-6 py-4 text-sm font-bold text-gray-900 dark:text-gray-100">Public Deals</td>
                  <td className="px-6 py-4 text-sm text-blue-700 dark:text-blue-300">&nbsp;</td>
                </tr>

                {/* Public Deals entries (single source of truth) */}
                {publicDeals.map((d) => {
                  const slug = (d.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
                  // Preferred mapping to existing chain logos when applicable
                  const dealChainLogoMap: Record<string, string> = {
                    'tempo fund': '/images/chains/base.png',
                    'ckgp': '/images/chains/polygon.png',
                    'sea solar series 1': '/images/chains/polygon.png',
                    'tau digital': '/images/chains/polygon.png',
                    'sea solar': '/images/chains/polygon.png'
                  };
                  const keyName = (d.name || '').toLowerCase();
                  const logoSrc = dealChainLogoMap[keyName] || `/images/logos/${slug}.svg`;
                  return (
                    <tr key={d.name} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                      <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                        <div className="flex items-center">
                          <img src={logoSrc} alt={d.name} className="w-6 h-6 mr-2 object-contain" />
                          <span>{d.name}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-blue-700 dark:text-blue-300">{formatUsd(d.value, d.decimals)}</td>
                    </tr>
                  );
                })}

                {/* Render pools grouped by their `type` field in POOLS */}
                {Array.from(
                  pools.reduce((map: Map<string, any[]>, p: any) => {
                    const key = p.type || 'Other';
                    if (!map.has(key)) map.set(key, []);
                    map.get(key)!.push(p);
                    return map;
                  }, new Map())
                ).map(([type, items]: any, idx) => (
                  <Fragment key={`group-${type}-${idx}`}>
                    <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                      <td className="px-6 py-4 text-sm font-bold text-gray-900 dark:text-gray-100">{TYPE_LABELS[type] || type}</td>
                      <td className="px-6 py-4 text-sm text-blue-700 dark:text-blue-300"></td>
                    </tr>
                    {items.map((p: any) => (
                      <tr key={p.address || p.name} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                        <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                          <div className="flex items-center">
                            <img
                              src={`/images/chains/${p.network}.svg`}
                              alt={p.network}
                              className="w-5 h-5 mr-2 object-contain"
                              data-attempt="0"
                              onError={(e) => {
                                const img = e.currentTarget as HTMLImageElement;
                                const attempt = parseInt(img.getAttribute('data-attempt') || '0', 10);
                                const candidates = [
                                  `/images/chains/${p.network}.svg`,
                                  `/images/chains/${p.network}.png`,
                                  `/images/${p.network}.svg`,
                                  `/images/${p.network}.png`,
                                ];
                                const next = attempt + 1;
                                if (next < candidates.length) {
                                  img.setAttribute('data-attempt', String(next));
                                  img.src = candidates[next];
                                } else {
                                  img.style.display = 'none';
                                }
                              }}
                            />
                            <span>{p.name}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-blue-700 dark:text-blue-300">{formatUsd(p.value || 0)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
