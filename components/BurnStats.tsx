"use client";

import React, { useState, useEffect, useMemo, Fragment, useRef, useLayoutEffect } from 'react';
import { TokenBurnStats } from '@/types';
import { formatValue, formatAddress, formatUsd } from '@/lib/utils';
import { PRIVATE_ENTRY as DEFAULT_PRIVATE_ENTRY, PUBLIC_DEALS as DEFAULT_PUBLIC_DEALS, TYPE_LABELS } from '@/lib/tvlConfig';
// Removed circle chart dependency (recharts) per request — keep visual summaries

interface BurnStatsProps {
  stats: TokenBurnStats;
  tokenSymbol?: string;
  pools?: any[];
  warnings?: string[];
}

const COLORS_TVL = ['#22d3ee', '#818cf8', '#34d399', '#f472b6', '#fbbf24']; // Cyan, Indigo, Emerald, Pink, Amber
const COLORS_BURN = ['#ef4444', '#14b8a6']; // Red (Burned), Teal (Circulating)

export default function BurnStats({ stats, tokenSymbol = 'IXS', pools = [], warnings = [] }: BurnStatsProps) {
  const ethTokenAddress = process.env.NEXT_PUBLIC_ETH_TOKEN_ADDRESS || '';
  const polygonTokenAddress = process.env.NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS || '';
  const baseTokenAddress = process.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS || '';

  // Data Loading for TVL Config
  const [privateEntry, setPrivateEntry] = useState(DEFAULT_PRIVATE_ENTRY);
  const [publicDeals, setPublicDeals] = useState(DEFAULT_PUBLIC_DEALS);
  // Dropdown state: whether detail panels are visible (closed by default)
  const [showBurnAddresses, setShowBurnAddresses] = useState<boolean>(false);
  const [showPlatformNumbers, setShowPlatformNumbers] = useState<boolean>(false);
  const [showLaunchpadDeals, setShowLaunchpadDeals] = useState<boolean>(false);
  const [showPlatformVolume, setShowPlatformVolume] = useState<boolean>(false);

  useEffect(() => {
    const fetchTvlConfig = async () => {
      try {
        const res = await fetch('/data/tvlConfig.json');
        if (res.ok) {
          const cfg = await res.json();
          if (cfg.privateEntry) setPrivateEntry(cfg.privateEntry);
          if (Array.isArray(cfg.publicDeals)) setPublicDeals(cfg.publicDeals);
        }
      } catch (e) { /* ignore */ }
    };
    fetchTvlConfig();
  }, []);

  // --- Calculations ---
  
  // 1. Burn Stats
  const MAX_SUPPLY = 180000000;
  // stats.totalBurned is a wei string — compute numeric token amount from raw wei
  const burnedTokens = (() => {
    try {
      const raw = String(stats?.totalBurned || '0');
      const bi = BigInt(raw);
      return Number(bi) / 1e18;
    } catch (e) {
      return 0;
    }
  })();
  // Ensure we don't go below zero
  const newMaxSupply = Math.max(0, MAX_SUPPLY - burnedTokens);
  
  // Percent burned of Total Original Supply
  const burnedPct = Math.min(100, Math.max(0, (burnedTokens / MAX_SUPPLY) * 100));

  // 2. TVL Items
  const tvlPrivateVal = Number(privateEntry.value) || 0;
  const tvlLaunchpadVal = (publicDeals || []).reduce((s, p) => s + (Number(p.value) || 0), 0);
  const tvlPoolsVal = (pools || []).reduce((s: number, p: any) => s + (Number(p.value) || 0), 0);
  const totalTvl = tvlPrivateVal + tvlPoolsVal; // Excluded launchpad from TVL

  // 3. Chart Data
  const burnChartData = [
    { name: 'Burned', value: burnedTokens },
    { name: 'Circulating', value: newMaxSupply },
  ];

  // Filter out zero values for cleaner chart
  const tvlChartData = [
    { name: 'Private Deals', value: tvlPrivateVal },
    { name: 'Launchpad', value: tvlLaunchpadVal },
    { name: 'Liquidity Pools', value: tvlPoolsVal },
  ].filter(d => d.value > 0);

  // Refs and state to align suffixes precisely next to centered numbers
  const burnedCardRef = useRef<HTMLButtonElement | null>(null);
  const burnedNumberRef = useRef<HTMLSpanElement | null>(null);

  const supplyCardRef = useRef<HTMLDivElement | null>(null);
  const supplyNumberRef = useRef<HTMLSpanElement | null>(null);
  const [supplySuffixLeft, setSupplySuffixLeft] = useState<string | null>(null);
  // Title centering refs for the supply card (center text, position checkmark separately)
  const supplyTitleRef = useRef<HTMLParagraphElement | null>(null);
  const supplyTitleTextRef = useRef<HTMLSpanElement | null>(null);
  const [supplyCheckLeft, setSupplyCheckLeft] = useState<string | null>(null);

  useLayoutEffect(() => {
    function positionCheck() {
      window.requestAnimationFrame(() => {
        if (supplyTitleRef.current && supplyTitleTextRef.current) {
          const textRect = supplyTitleTextRef.current.getBoundingClientRect();
          const half = Math.round(textRect.width / 2);
          setSupplyCheckLeft(`calc(50% + ${half + 8}px)`);
        }
      });
    }

    // (keep dropdowns closed by default; do not auto-open on desktop)
    positionCheck();
    window.addEventListener('resize', positionCheck);
    return () => window.removeEventListener('resize', positionCheck);
  }, [stats?.totalBurned, newMaxSupply]);

  // Order of metric cards as they appear in the grid
  const cardOrder = ['supply', 'burned', 'tvl', 'launchpad', 'platformVolume'];
  const cols = 3;


  if (!stats || !Array.isArray(stats.burnAddresses) || stats.burnAddresses.length === 0) {
    return (
      <div className="p-6 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-700">
        <p>No burn statistics available yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      
      {/* --- Top Metrics Grid --- */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 relative">
        {/* Column 1: Supply (top) + Launchpad (below) — stacking ensures panels push only this column */}
        <div className="flex flex-col gap-6">
          <div ref={supplyCardRef} className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 border-t-4 border-t-[#ff3b30] p-6 flex flex-col justify-between relative overflow-visible min-h-[140px]">
            <p ref={supplyTitleRef} className="text-sm font-semibold text-teal-500 dark:text-teal-400 text-center relative">
              <span ref={supplyTitleTextRef} className="inline-block">Max Supply - Fully Circulating</span>
              <svg style={{ position: 'absolute', top: '50%', left: supplyCheckLeft !== null ? supplyCheckLeft : '50%', transform: supplyCheckLeft !== null ? 'translate(0, -50%)' : 'translate(8px, -50%)' }} className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-7.071 7.071a1 1 0 01-1.414 0l-3.182-3.182a1 1 0 011.414-1.414L9 11.586l6.293-6.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
            </p>
            <div className="flex-1 flex items-center justify-center">
              <div className="relative inline-block pointer-events-none">
                <span ref={supplyNumberRef} className="text-3xl font-bold text-gray-900 dark:text-white whitespace-nowrap">
                  {newMaxSupply.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
                <span className="absolute left-full top-1/2 transform -translate-y-1/2 ml-1">
                  <span className="text-sm text-gray-500 whitespace-nowrap">IXS</span>
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col relative">
            <button onClick={() => setShowLaunchpadDeals(s => !s)} aria-expanded={showLaunchpadDeals} className="text-left bg-white dark:bg-gray-800 rounded-t-xl shadow-sm border border-gray-100 dark:border-gray-700 border-t-4 border-t-[#f472b6] p-6 flex flex-col justify-between relative overflow-visible z-20 hover:shadow-md transition-shadow pb-8 min-h-[140px]">
              <p className="text-sm font-semibold text-teal-500 dark:text-teal-400 text-center">Launchpad Deals</p>
              <div className="flex-1 flex items-center justify-center">
                <span className="text-3xl font-bold text-gray-900 dark:text-white">
                  {formatUsd(tvlLaunchpadVal, 0)}
                </span>
              </div>

              <span className={`absolute left-1/2 transform -translate-x-1/2 bottom-0 ${showLaunchpadDeals ? 'rotate-180' : ''} translate-y-1/2`} aria-hidden>
                <svg className="w-4 h-4 text-gray-400 dark:text-gray-300" viewBox="0 0 20 20" fill="currentColor"><path d="M5.23 7.21a.75.75 0 011.06-.02L10 10.88l3.71-3.69a.75.75 0 111.06 1.06l-4.24 4.22a.75.75 0 01-1.06 0L5.25 8.25a.75.75 0 01-.02-1.04z"/></svg>
              </span>
            </button>
            {showLaunchpadDeals && (
              <div className="bg-white dark:bg-gray-800 rounded-b-xl shadow-sm border border-gray-100 dark:border-gray-700 border-t-0 overflow-hidden flex flex-col z-0 mt-0">
                <div className="flex-1 divide-y divide-gray-100 dark:divide-gray-700">
                  {(publicDeals || []).map((d: any, i: number) => (
                    <div key={`${d.name}-${i}`} className="p-4 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <img src={`/images/chains/${d.network}.png`} onError={(e) => { e.currentTarget.src = `/images/chains/${d.network}.svg` }} alt={d.network} className="w-6 h-6 object-contain" />
                        <div className="text-sm font-medium text-gray-900 dark:text-white">{d.name}</div>
                        <div className="text-xs text-gray-500">{d.description || d.network}</div>
                      </div>
                      <div className="text-sm font-mono font-bold text-gray-700 dark:text-gray-300">{formatUsd(d.value || 0)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Column 2: Burned (top) + Platform Volume (below) */}
        <div className="flex flex-col gap-6">
          <div className="flex flex-col relative">
            <button ref={burnedCardRef} onClick={() => setShowBurnAddresses(s => !s)} aria-expanded={showBurnAddresses} className="text-left bg-white dark:bg-gray-800 rounded-t-xl shadow-sm border border-gray-100 dark:border-gray-700 border-t-4 border-t-[#ff3b30] p-6 flex flex-col justify-between relative overflow-visible z-20 hover:shadow-md transition-shadow pb-8 min-h-[140px]">
              <p className="text-sm font-semibold text-teal-500 dark:text-teal-400 text-center">Total Tokens Burned</p>
              <div className="flex-1 flex items-center justify-center">
                <div className="relative inline-block pointer-events-none">
                  <span ref={burnedNumberRef} className="text-3xl font-bold text-gray-900 dark:text-white whitespace-nowrap">
                    {formatValue(String(stats.totalBurned), 2)}
                  </span>
                  <span className="absolute left-full top-1/2 transform -translate-y-1/2 ml-1">
                    <span className="text-sm font-medium text-red-600 dark:text-[#ff3b30] bg-red-100 dark:bg-red-950/40 px-2 py-0.5 rounded-full shadow-[0_0_10px_rgba(255,59,48,0.3)] border border-red-200 dark:border-red-900/50 whitespace-nowrap">
                      {burnedPct.toFixed(2)}%
                    </span>
                  </span>
                </div>
              </div>

              <span className={`absolute left-1/2 transform -translate-x-1/2 bottom-0 ${showBurnAddresses ? 'rotate-180' : ''} translate-y-1/2`} aria-hidden>
                <svg className="w-4 h-4 text-gray-400 dark:text-gray-300" viewBox="0 0 20 20" fill="currentColor"><path d="M5.23 7.21a.75.75 0 011.06-.02L10 10.88l3.71-3.69a.75.75 0 111.06 1.06l-4.24 4.22a.75.75 0 01-1.06 0L5.25 8.25a.75.75 0 01-.02-1.04z"/></svg>
              </span>
            </button>
            {showBurnAddresses && (
              <div className="bg-white dark:bg-gray-800 rounded-b-xl shadow-sm border border-gray-100 dark:border-gray-700 border-t-0 overflow-hidden flex flex-col z-0 mt-0">
                <div className="flex-1 divide-y divide-gray-100 dark:divide-gray-700">
                  {stats.burnAddresses.map((burn) => {
                    let networkLabel = 'Unknown';
                    let explorerUrl = '#';
                    let tokenAddress = '';
                    if (burn.network === 'ethereum') {
                      networkLabel = 'Ethereum';
                      tokenAddress = ethTokenAddress;
                      explorerUrl = `https://etherscan.io/token/${tokenAddress}?a=${burn.address}`;
                    } else if (burn.network === 'polygon') {
                      networkLabel = 'Polygon';
                      tokenAddress = polygonTokenAddress;
                      explorerUrl = `https://polygonscan.com/token/${tokenAddress}?a=${burn.address}`;
                    } else if (burn.network === 'base') {
                      networkLabel = 'Base';
                      tokenAddress = baseTokenAddress;
                      explorerUrl = `https://basescan.org/token/${tokenAddress}?a=${burn.address}`;
                    }
                    return (
                      <div key={`${burn.network}-${burn.address}`} className="p-4 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-3">
                            <img
                              src={`/images/chains/${burn.network}.png`}
                              onError={(e) => { e.currentTarget.src = `/images/chains/${burn.network}.svg` }}
                              alt={networkLabel}
                              className="w-6 h-6 object-contain"
                            />
                            <div>
                              <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300 font-mono">
                                {formatAddress(burn.address)}
                              </a>
                            </div>
                          </div>
                        </div>
                        <div className="flex justify-between items-center bg-gray-50 dark:bg-gray-900/50 rounded p-2">
                          <span className="text-xs text-gray-500 uppercase font-semibold tracking-wider">Burned</span>
                          <span className="text-sm font-bold text-white drop-shadow-[0_0_5px_rgba(255,59,48,0.6)] font-mono">{formatValue(burn.balance)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col relative">
            <button onClick={() => setShowPlatformVolume(s => !s)} aria-expanded={showPlatformVolume} className="text-left bg-white dark:bg-gray-800 rounded-t-xl shadow-sm border border-gray-100 dark:border-gray-700 border-t-4 border-t-indigo-500 p-6 flex flex-col justify-between relative overflow-visible z-20 hover:shadow-md transition-shadow pb-8 min-h-[140px]">
              <p className="text-sm font-semibold text-teal-500 dark:text-teal-400 text-center">Platform Volume</p>
              <div className="flex-1 flex items-center justify-center">
                <span className="text-3xl font-bold text-gray-900 dark:text-white">
                  {formatUsd(tvlPoolsVal, 0)}
                </span>
              </div>

              <span className={`absolute left-1/2 transform -translate-x-1/2 bottom-0 ${showPlatformVolume ? 'rotate-180' : ''} translate-y-1/2`} aria-hidden>
                <svg className="w-4 h-4 text-gray-400 dark:text-gray-300" viewBox="0 0 20 20" fill="currentColor"><path d="M5.23 7.21a.75.75 0 011.06-.02L10 10.88l3.71-3.69a.75.75 0 111.06 1.06l-4.24 4.22a.75.75 0 01-1.06 0L5.25 8.25a.75.75 0 01-.02-1.04z"/></svg>
              </span>
            </button>
            {showPlatformVolume && (
              <div className="bg-white dark:bg-gray-800 rounded-b-xl shadow-sm border border-gray-100 dark:border-gray-700 border-t-0 overflow-hidden flex flex-col z-0 mt-0">
                <div className="p-4">
                  <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">Platform pools</div>
                  <div className="space-y-2">
                    {(pools || []).length === 0 ? (
                      <div className="text-sm text-gray-500 dark:text-gray-400">No platform pools configured</div>
                    ) : (
                      (pools || []).map((p: any, i: number) => (
                        <div key={`${p.network}-${p.name}-${i}`} className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <img src={`/images/chains/${p.network}.png`} onError={(e) => { e.currentTarget.src = `/images/chains/${p.network}.svg` }} alt={p.network} className="w-5 h-5 object-contain" />
                            <div className="text-sm text-gray-900 dark:text-white">{p.name}</div>
                          </div>
                          <div className="text-sm font-mono text-gray-700 dark:text-gray-300">{formatUsd(p.value || 0)}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Column 3: TVL (single column) */}
        <div className="flex flex-col gap-6">
          <div className="flex flex-col relative">
            <button onClick={() => setShowPlatformNumbers(s => !s)} aria-expanded={showPlatformNumbers} className="text-left bg-white dark:bg-gray-800 rounded-t-xl shadow-sm border border-gray-100 dark:border-gray-700 border-t-4 border-t-cyan-500 p-6 flex flex-col justify-between relative overflow-visible z-20 hover:shadow-md transition-shadow pb-8 min-h-[140px]">
              <p className="text-sm font-semibold text-teal-500 dark:text-teal-400 text-center">Total Value Locked</p>
              <div className="flex-1 flex items-center justify-center">
                <span className="text-3xl font-bold text-gray-900 dark:text-white">
                  {formatUsd(totalTvl, 0)}
                </span>
              </div>

              <span className={`absolute left-1/2 transform -translate-x-1/2 bottom-0 ${showPlatformNumbers ? 'rotate-180' : ''} translate-y-1/2`} aria-hidden>
                <svg className="w-4 h-4 text-gray-400 dark:text-gray-300" viewBox="0 0 20 20" fill="currentColor"><path d="M5.23 7.21a.75.75 0 011.06-.02L10 10.88l3.71-3.69a.75.75 0 111.06 1.06l-4.24 4.22a.75.75 0 01-1.06 0L5.25 8.25a.75.75 0 01-.02-1.04z"/></svg>
              </span>
            </button>
            {showPlatformNumbers && (
              <div className="bg-white dark:bg-gray-800 rounded-b-xl shadow-sm border border-gray-100 dark:border-gray-700 border-t-0 overflow-hidden flex flex-col z-0 mt-0">
                {warnings && warnings.length > 0 && (
                  <div className="text-xs text-yellow-600 bg-yellow-50 px-2 py-1 rounded border border-yellow-200 text-right mb-2">{warnings.length} warning(s)</div>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50 dark:bg-gray-900/50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Asset / Deal</th>
                        <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Value (USD)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center">
                            <img src="/images/chains/blockchain.svg" onError={(e) => { e.currentTarget.style.display = 'none'; }} alt="" className="w-6 h-6 mr-2 object-contain" />
                            <div>
                              <div className="text-sm font-medium text-gray-900 dark:text-white">{privateEntry.label}</div>
                              <div className="text-xs text-gray-500 mt-1">Verified by <a href={privateEntry.verifiedBy.href} target="_blank" className="text-cyan-600 hover:underline dark:text-cyan-400">{privateEntry.verifiedBy.label}</a></div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-center"><span className="px-2 py-1 text-xs rounded-full bg-cyan-100 text-cyan-800 dark:bg-cyan-500/10 dark:text-cyan-400 dark:border dark:border-cyan-500/20">Private</span></td>
                        <td className="px-6 py-4 text-right text-sm font-bold text-gray-700 dark:text-gray-300">{formatUsd(privateEntry.value, 0)}</td>
                      </tr>
                      {Array.from(pools.reduce((map: Map<string, any[]>, p: any) => {
                        const key = p.type || 'Other'; if (!map.has(key)) map.set(key, []); map.get(key)!.push(p); return map; }, new Map())).map(([type, items]: any) => (
                        <Fragment key={type}>
                          <tr className="bg-gray-50/50 dark:bg-gray-800/50 border-t border-gray-200 dark:border-gray-700"><td colSpan={3} className="px-6 py-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest pl-4">{TYPE_LABELS[type] || type}</td></tr>
                          {items.map((p: any, i: number) => (
                            <tr key={`${p.network}-${p.name}-${i}`} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                              <td className="px-6 py-4"><div className="flex items-center"><img src={`/images/chains/${p.network}.png`} onError={(e) => { e.currentTarget.src = `/images/chains/${p.network}.svg` }} alt={p.network} className="w-6 h-6 mr-2 object-contain" /><div><div className="text-sm font-medium text-gray-900 dark:text-white">{p.name}</div></div></div></td>
                              <td className="px-6 py-4 text-center"><span className="px-2 py-1 text-xs rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border dark:border-emerald-500/20">Liquidity</span></td>
                              <td className="px-6 py-4 text-right text-sm font-mono text-gray-700 dark:text-gray-300">{formatUsd(p.value || 0)}</td>
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
        </div>
      </div>

      {/* Panels are rendered inline beneath each card so they stay attached and only push content in their column */}

      <div className="text-right text-xs text-gray-400 pt-8 pb-4">Last updated: {new Date(stats.lastUpdated).toLocaleString()}</div>
    </div>
  );
}
