"use client";

import React, { useState, useEffect, useMemo, Fragment } from 'react';
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
  // stats.totalBurned is a wei string
  const burnedTokens = parseFloat(formatValue(String(stats?.totalBurned || 0), 6)) || 0;
  // Ensure we don't go below zero
  const newMaxSupply = Math.max(0, MAX_SUPPLY - burnedTokens);
  
  // Percent burned of Total Original Supply
  const burnedPct = Math.min(100, Math.max(0, (burnedTokens / MAX_SUPPLY) * 100));

  // 2. TVL Items
  const tvlPrivateVal = Number(privateEntry.value) || 0;
  const tvlLaunchpadVal = (publicDeals || []).reduce((s, p) => s + (Number(p.value) || 0), 0);
  const tvlPoolsVal = (pools || []).reduce((s: number, p: any) => s + (Number(p.value) || 0), 0);
  const totalTvl = tvlPrivateVal + tvlLaunchpadVal + tvlPoolsVal;

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
        
        {/* Metric 1: Burned */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 border-t-4 border-t-[#ff3b30] p-6 flex flex-col justify-between relative overflow-hidden z-10">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400 text-center">Total Tokens Burned</p>
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-nowrap items-center gap-2">
               <span className="text-3xl font-bold text-gray-900 dark:text-white whitespace-nowrap">
                 {formatValue(String(stats.totalBurned), 2)}
               </span>
               <span className="text-sm font-medium text-red-600 dark:text-[#ff3b30] bg-red-100 dark:bg-red-950/40 px-2 py-0.5 rounded-full shadow-[0_0_10px_rgba(255,59,48,0.3)] border border-red-200 dark:border-red-900/50 whitespace-nowrap">
                 {burnedPct.toFixed(2)}%
               </span>
            </div>
          </div>
        </div>

        {/* Pointer between cards */}
        <div className="hidden md:flex absolute left-[calc(33.333%-12px)] top-1/2 -translate-y-1/2 z-20 text-gray-400 dark:text-gray-500 text-2xl font-bold">
          &gt;
        </div>

        {/* Metric 2: Supply */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 border-t-4 border-t-[#ff3b30] p-6 flex flex-col justify-between relative overflow-visible">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400 text-center">Max Token Supply</p>
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-nowrap items-baseline gap-2">
              <span className="text-3xl font-bold text-gray-900 dark:text-white whitespace-nowrap">
                {newMaxSupply.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
              <span className="text-sm text-gray-500 whitespace-nowrap">IXS</span>
            </div>
          </div>
        </div>

        {/* Metric 3: TVL */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 border-t-4 border-t-cyan-500 p-6 flex flex-col justify-between relative overflow-visible">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400 text-center">Total Value Locked</p>
          <div className="flex-1 flex items-center justify-center">
            <span className="text-3xl font-bold text-gray-900 dark:text-white">
              {formatUsd(totalTvl, 0)}
            </span>
          </div>
        </div>
      </div>

      {/* --- Details Section --- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 relative">
        
        {/* Left Col: Burn Details List */}
        <div className="lg:col-span-1 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 border-t-4 border-t-[#ff3b30] overflow-hidden flex flex-col h-full relative z-10">
          <div className="p-6 border-b border-gray-100 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white text-center">Burn Addresses</h3>
          </div>
          <div className="flex-1 divide-y divide-gray-100 dark:divide-gray-700">
            {stats.burnAddresses.map((burn) => {
               // Determine explorer & style
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
                            onError={(e) => { e.currentTarget.src = `/images/chains/${burn.network}.svg`}}
                            alt={networkLabel} 
                            className="w-8 h-8 object-contain" 
                          />
                          <div>
                            <p className="text-sm font-medium text-gray-900 dark:text-white">{networkLabel}</p>
                            <a 
                              href={explorerUrl} target="_blank" rel="noopener noreferrer"
                              className="text-xs text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300 font-mono"
                            >
                              {formatAddress(burn.address)}
                            </a>
                          </div>
                       </div>
                    </div>
                    <div className="flex justify-between items-center bg-gray-50 dark:bg-gray-900/50 rounded p-2">
                       <span className="text-xs text-gray-500 uppercase font-semibold tracking-wider">Burned</span>
                       <span className="text-sm font-bold text-red-600 dark:text-[#ff3b30] drop-shadow-[0_0_5px_rgba(255,59,48,0.6)] font-mono">
                         {formatValue(burn.balance)}
                       </span>
                    </div>
                 </div>
               );
            })}
          </div>
        </div>

        {/* Right Col: TVL Details Table (Takes 2 cols) */}
        <div className="lg:col-span-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 border-t-4 border-t-cyan-500 overflow-hidden flex flex-col h-full relative z-10">
          <div className="p-6 border-b border-gray-100 dark:border-gray-700 flex justify-center items-center bg-white dark:bg-gray-800 sticky top-0 z-10 relative">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white text-center">IXS Platform Numbers</h3>
            {warnings && warnings.length > 0 && (
               <div className="text-xs text-yellow-600 bg-yellow-50 px-2 py-1 rounded border border-yellow-200 absolute right-6">
                 {warnings.length} warning(s)
               </div>
            )}
          </div>
          
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
                 {/* 1. Private Entry */}
                 <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                    <td className="px-6 py-4">
                       <div className="text-sm font-medium text-gray-900 dark:text-white">{privateEntry.label}</div>
                       <div className="text-xs text-gray-500 mt-1">
                         Verified by <a href={privateEntry.verifiedBy.href} target="_blank" className="text-cyan-600 hover:underline dark:text-cyan-400">{privateEntry.verifiedBy.label}</a>
                       </div>
                    </td>
                    <td className="px-6 py-4 text-center">
                       <span className="px-2 py-1 text-xs rounded-full bg-cyan-100 text-cyan-800 dark:bg-cyan-500/10 dark:text-cyan-400 dark:border dark:border-cyan-500/20 shadow-[0_0_10px_rgba(34,211,238,0.1)]">Private</span>
                    </td>
                    <td className="px-6 py-4 text-right text-sm font-bold text-gray-700 dark:text-gray-300">
                       {formatUsd(privateEntry.value, 0)}
                    </td>
                 </tr>

                 {/* 2. Public Deals */}
                 {publicDeals.map((d) => {
                    const slug = (d.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
                    const dealChainLogoMap: Record<string, string> = {
                      'tempo fund': '/images/chains/base.png',
                      'ckgp': '/images/chains/polygon.png',
                      'sea solar series 1': '/images/chains/polygon.png',
                      'tau digital': '/images/chains/polygon.png',
                      'sea solar': '/images/chains/polygon.png'
                    };
                    const keyName = (d.name || '').toLowerCase();
                    const logoSrc = dealChainLogoMap[keyName] || `/images/logos/${slug}.png`;
                    return (
                      <tr key={d.name} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                         <td className="px-6 py-4">
                            <div className="flex items-center">
                               <img 
                                 src={logoSrc} 
                                 onError={(e) => { e.currentTarget.style.display = 'none'; }}
                                 alt="" className="w-8 h-8 mr-3 object-contain" 
                               />
                               <span className="text-sm font-medium text-gray-900 dark:text-white">{d.name}</span>
                            </div>
                         </td>
                         <td className="px-6 py-4 text-center">
                            <span className="px-2 py-1 text-xs rounded-full bg-indigo-100 text-indigo-800 dark:bg-indigo-500/10 dark:text-indigo-400 dark:border dark:border-indigo-500/20 shadow-[0_0_10px_rgba(129,140,248,0.1)]">Launchpad</span>
                         </td>
                         <td className="px-6 py-4 text-right text-sm font-mono text-gray-700 dark:text-gray-300">
                            {formatUsd(d.value, d.decimals)}
                         </td>
                      </tr>
                    );
                 })}

                 {/* 3. Pools Breakdown */}
                 {Array.from(pools.reduce((map: Map<string, any[]>, p: any) => {
                    const key = p.type || 'Other';
                    if (!map.has(key)) map.set(key, []);
                    map.get(key)!.push(p);
                    return map;
                  }, new Map())).map(([type, items]: any) => (
                    <Fragment key={type}>
                       {/* Group Header Row */}
                       <tr className="bg-gray-50/50 dark:bg-gray-800/50 border-t border-gray-200 dark:border-gray-700">
                          <td colSpan={3} className="px-6 py-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest pl-4">
                             {TYPE_LABELS[type] || type}
                          </td>
                       </tr>
                       {items.map((p: any, i: number) => (
                          <tr key={`${p.network}-${p.name}-${i}`} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                             <td className="px-6 py-4">
                               <div className="flex items-center">
                                 <img
                                   src={`/images/chains/${p.network}.png`}
                                   onError={(e) => { e.currentTarget.src = `/images/chains/${p.network}.svg`}}
                                   alt={p.network}
                                   className="w-8 h-8 mr-3 object-contain"
                                 />
                                 <div>
                                   <div className="text-sm font-medium text-gray-900 dark:text-white">{p.name}</div>
                                 </div>
                               </div>
                             </td>
                             <td className="px-6 py-4 text-center">
                               <span className="px-2 py-1 text-xs rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border dark:border-emerald-500/20 shadow-[0_0_10px_rgba(52,211,153,0.1)]">Liquidity</span>
                             </td>
                             <td className="px-6 py-4 text-right text-sm font-mono text-gray-700 dark:text-gray-300">
                               {formatUsd(p.value || 0)}
                             </td>
                          </tr>
                       ))}
                    </Fragment>
                 ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    
      <div className="text-right text-xs text-gray-400 pt-8 pb-4">
         Last updated: {new Date(stats.lastUpdated).toLocaleString()}
      </div>
    </div>
  );
}
