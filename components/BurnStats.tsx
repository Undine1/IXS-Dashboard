"use client";

import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import Image from 'next/image';
import { Pool, TokenBurnStats, TvlPrivateEntry, TvlPublicDeal } from '@/types';
import { formatValue, formatAddress, formatUsd, formatNumber } from '@/lib/utils';
import { PRIVATE_ENTRY as DEFAULT_PRIVATE_ENTRY, PUBLIC_DEALS as DEFAULT_PUBLIC_DEALS, TYPE_LABELS } from '@/lib/tvlConfig';
import LAYOUT from '@/lib/layoutConfig';
// Removed circle chart dependency (recharts) per request — keep visual summaries

interface BurnStatsProps {
  stats: TokenBurnStats;
  tokenSymbol?: string;
  pools?: Pool[];
  warnings?: string[];
}

interface TvlConfigPayload {
  privateEntry?: TvlPrivateEntry;
  publicDeals?: TvlPublicDeal[];
}

interface PoolVolumeEntry {
  total_usd?: number | string;
}

interface PoolVolumeData {
  total_usd?: number | string;
  pools?: Record<string, PoolVolumeEntry>;
}

interface PoolVolumeResponse {
  ok?: boolean;
  data?: PoolVolumeData;
}

function toFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

interface ChainIconProps {
  network: string;
  alt: string;
}

interface CardAtmosphereProps {
  accentClass: string;
  subtle?: boolean;
}

interface CardRailProps {
  gradientClass: string;
  roundedClass: string;
}

function ChainIcon({ network, alt }: ChainIconProps) {
  const prefersSvg = network === 'blockchain';
  const primarySrc = prefersSvg ? `/images/chains/${network}.svg` : `/images/chains/${network}.png`;
  const fallbackSrc = prefersSvg ? `/images/chains/${network}.png` : `/images/chains/${network}.svg`;
  const [src, setSrc] = useState(primarySrc);

  useEffect(() => {
    setSrc(primarySrc);
  }, [primarySrc]);

  return (
    <Image
      src={src}
      alt={alt}
      width={20}
      height={20}
      className="w-5 h-5 object-contain"
      onError={() => {
        setSrc((current) => (current === fallbackSrc ? current : fallbackSrc));
      }}
    />
  );
}

function CardAtmosphere({ accentClass, subtle = false }: CardAtmosphereProps) {
  const glowOpacity = subtle ? 'opacity-[0.08] dark:opacity-[0.12]' : 'opacity-[0.12] dark:opacity-[0.16]';
  const washOpacity = subtle ? 'opacity-30 dark:opacity-20' : 'opacity-40 dark:opacity-26';

  return (
    <div className="pointer-events-none absolute inset-0 -z-10 rounded-[inherit] overflow-hidden">
      <div className={`absolute -right-10 -top-14 h-40 w-40 rounded-full blur-[64px] ${accentClass} ${glowOpacity}`} />
      <div className={`absolute inset-0 rounded-[inherit] bg-white/50 dark:bg-white/[0.05] ${washOpacity}`} />
    </div>
  );
}

function CardRail({ gradientClass, roundedClass }: CardRailProps) {
  return (
    <div className={`pointer-events-none absolute inset-0 ${roundedClass} overflow-hidden`} aria-hidden>
      <div className={`absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r opacity-70 ${gradientClass}`} />
    </div>
  );
}

export default function BurnStats({ stats, tokenSymbol = 'IXS', pools = [], warnings = [] }: BurnStatsProps) {
  const ethTokenAddress = process.env.NEXT_PUBLIC_ETH_TOKEN_ADDRESS || '';
  const polygonTokenAddress = process.env.NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS || '';
  const baseTokenAddress = process.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS || '';

  // Data Loading for TVL Config
  const [privateEntry, setPrivateEntry] = useState<TvlPrivateEntry>(DEFAULT_PRIVATE_ENTRY);
  const [publicDeals, setPublicDeals] = useState<TvlPublicDeal[]>(DEFAULT_PUBLIC_DEALS);
  // Dropdown state: whether detail panels are visible (closed by default)
  const [showBurnAddresses, setShowBurnAddresses] = useState<boolean>(false);
  const [showPlatformNumbers, setShowPlatformNumbers] = useState<boolean>(false);
  const [showLaunchpadDeals, setShowLaunchpadDeals] = useState<boolean>(false);
  const [showPlatformVolume, setShowPlatformVolume] = useState<boolean>(false);
  // Map of per-pool volumes keyed by lowercased pool address (or null when explicitly N/A)
  const [poolVolumeMap, setPoolVolumeMap] = useState<Record<string, number | null> | null>(null);
  // Aggregate platform pools total (sum of numeric per-pool values) or null when unavailable
  const [poolVolumeTotal, setPoolVolumeTotal] = useState<number | null>(null);

  useEffect(() => {
    const fetchTvlConfig = async () => {
      try {
        const res = await fetch('/data/tvlConfig.json');
        if (res.ok) {
          const cfg = (await res.json()) as TvlConfigPayload;
          if (cfg.privateEntry) {
            setPrivateEntry({
              label: cfg.privateEntry.label || DEFAULT_PRIVATE_ENTRY.label,
              value: toFiniteNumberOrNull(cfg.privateEntry.value ?? DEFAULT_PRIVATE_ENTRY.value),
              verifiedBy: cfg.privateEntry.verifiedBy || DEFAULT_PRIVATE_ENTRY.verifiedBy,
            });
          }
          if (Array.isArray(cfg.publicDeals)) setPublicDeals(cfg.publicDeals);
        }
      } catch {
        // ignore tvl config fetch issues and keep defaults
      }
    };
    fetchTvlConfig();

    // fetch persisted pool volume (supports legacy total_usd or per-pool mapping)
    const fetchPoolVolume = async () => {
      try {
        const res = await fetch('/api/poolVolume');
        if (!res.ok) return;
        const j = (await res.json()) as PoolVolumeResponse;
        if (!j || !j.ok || !j.data) return;

        // Legacy single total_usd -> set total and clear per-pool map
        if (typeof j.data.total_usd !== 'undefined') {
          setPoolVolumeTotal(toFiniteNumberOrNull(j.data.total_usd));
          setPoolVolumeMap(null);
          return;
        }

        // New format: per-pool mapping
        if (j.data.pools) {
          const map: Record<string, number | null> = {};
          for (const k of Object.keys(j.data.pools)) {
            const entry = j.data.pools[k];
            if (entry && typeof entry.total_usd !== 'undefined') map[k.toLowerCase()] = toFiniteNumberOrNull(entry.total_usd);
            else map[k.toLowerCase()] = null; // explicit N/A for this pool
          }
          setPoolVolumeMap(map);
          const numericSum = Object.values(map).filter((v) => typeof v === 'number') as number[];
          const total = numericSum.length ? numericSum.reduce((s, v) => s + v, 0) : null;
          setPoolVolumeTotal(total);
          return;
        }
      } catch {
        // ignore pool volume fetch issues and keep fallback values
      }
    };
    fetchPoolVolume();
  }, []);

  // --- Calculations ---
  
  // 1. Burn Stats
  const MAX_SUPPLY = 180000000;
  // stats.totalBurned is a wei string — compute numeric token amount from raw wei
  const burnedTokens = (() => {
    try {
      if (!stats?.totalBurned) return null;
      const raw = String(stats.totalBurned);
      const bi = BigInt(raw);
      const parsed = Number(bi) / 1e18;
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  })();
  // Ensure we don't go below zero
  const newMaxSupply = burnedTokens === null ? null : Math.max(0, MAX_SUPPLY - burnedTokens);
  
  // Percent burned of Total Original Supply
  const burnedPct = burnedTokens === null ? null : Math.min(100, Math.max(0, (burnedTokens / MAX_SUPPLY) * 100));

  // 2. TVL Items
  const tvlPrivateVal = toFiniteNumberOrNull(privateEntry.value);
  const launchpadValues = publicDeals.map((deal) => toFiniteNumberOrNull(deal.value));
  const hasUnknownLaunchpadValues = launchpadValues.some((value) => value === null);
  const tvlLaunchpadVal = hasUnknownLaunchpadValues
    ? null
    : launchpadValues.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const poolValues = pools.map((pool) => toFiniteNumberOrNull(pool.value));
  const hasUnknownPoolValues = poolValues.some((value) => value === null);
  const tvlPoolsVal = hasUnknownPoolValues
    ? null
    : poolValues.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const totalTvl = tvlPrivateVal === null || tvlPoolsVal === null ? null : tvlPrivateVal + tvlPoolsVal; // Excluded launchpad from TVL
  // Platform Volume: sum of Crypto pools (treat pool.value as the pool's USD volume/liquidity)
  const cryptoPools = pools.filter((pool) => pool.type === 'Crypto');
  const poolsByType = pools.reduce<Record<string, Pool[]>>((acc, pool) => {
    const key = pool.type || 'Other';
    if (!acc[key]) acc[key] = [];
    acc[key].push(pool);
    return acc;
  }, {});

  // Refs and state to align suffixes precisely next to centered numbers
  const burnedCardRef = useRef<HTMLButtonElement | null>(null);
  const burnedNumberRef = useRef<HTMLSpanElement | null>(null);

  const supplyCardRef = useRef<HTMLDivElement | null>(null);
  const supplyNumberRef = useRef<HTMLSpanElement | null>(null);
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
          <div ref={supplyCardRef} className="isolate bg-gradient-to-br from-white/95 via-white/90 to-emerald-50/40 dark:from-slate-800/95 dark:via-slate-800/90 dark:to-emerald-950/15 rounded-2xl shadow-sm border border-gray-100/90 dark:border-slate-700 px-6 pt-8 pb-8 flex flex-col justify-between relative overflow-visible min-h-[140px]">
            <CardAtmosphere accentClass="bg-emerald-400" />
            <CardRail gradientClass="from-emerald-400 via-teal-300 to-cyan-300" roundedClass="rounded-2xl" />
            <p ref={supplyTitleRef} className="text-sm font-semibold text-teal-500 dark:text-teal-400 text-center relative">
              <span ref={supplyTitleTextRef} className="inline-block">Max Supply - Fully Circulating</span>
              <svg style={{ position: 'absolute', top: '50%', left: supplyCheckLeft !== null ? supplyCheckLeft : '50%', transform: supplyCheckLeft !== null ? 'translate(0, -50%)' : 'translate(8px, -50%)' }} className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-7.071 7.071a1 1 0 01-1.414 0l-3.182-3.182a1 1 0 011.414-1.414L9 11.586l6.293-6.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
            </p>
            <div className="flex-1 flex items-center justify-center">
              <div className="relative inline-block pointer-events-none">
                <span ref={supplyNumberRef} className="text-3xl font-bold text-gray-900 dark:text-white whitespace-nowrap">
                  {newMaxSupply === null ? 'N/A' : formatNumber(newMaxSupply, 0)}
                </span>
                {newMaxSupply !== null && (
                  <span className="absolute left-full top-1/2 transform -translate-y-1/2 ml-1">
                    <span className="text-sm text-gray-500 whitespace-nowrap">{tokenSymbol || 'IXS'}</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="isolate bg-white/95 dark:bg-slate-800/95 rounded-2xl border border-gray-100/90 dark:border-slate-700 shadow-sm overflow-hidden flex flex-col relative">
            <div className="pointer-events-none absolute inset-0 -z-20 bg-indigo-50/30 dark:bg-indigo-950/14" />
            <CardAtmosphere accentClass="bg-indigo-400" />
            <button
              onClick={() => setShowPlatformVolume(s => !s)}
              aria-expanded={showPlatformVolume}
              className={`text-left bg-transparent px-6 pt-8 pb-8 flex flex-col justify-between relative overflow-visible z-20 min-h-[140px] transition-[filter] duration-200 hover:brightness-[1.01] ${
                showPlatformVolume
                  ? 'rounded-t-2xl border-b border-gray-100/80 dark:border-slate-700/80'
                  : 'rounded-2xl'
              }`}
            >
              <CardRail gradientClass="from-indigo-400 via-violet-300 to-sky-300" roundedClass="rounded-t-2xl" />
              <p className="text-sm font-semibold text-teal-500 dark:text-teal-400 text-center">Platform Volume</p>
                <div className="flex-1 flex items-center justify-center">
                  <span className="text-3xl font-bold text-gray-900 dark:text-white">
                    {poolVolumeTotal === null ? (
                      <span className="text-sm text-gray-500 dark:text-gray-400">N/A</span>
                    ) : (
                      <span>{formatUsd(poolVolumeTotal, 0)}</span>
                    )}
                  </span>
                </div>

              <span className={`absolute left-1/2 -translate-x-1/2 bottom-2 ${showPlatformVolume ? 'rotate-180' : ''}`} aria-hidden>
                <svg className="w-4 h-4 text-gray-400 dark:text-gray-300" viewBox="0 0 20 20" fill="currentColor"><path d="M5.23 7.21a.75.75 0 011.06-.02L10 10.88l3.71-3.69a.75.75 0 111.06 1.06l-4.24 4.22a.75.75 0 01-1.06 0L5.25 8.25a.75.75 0 01-.02-1.04z"/></svg>
              </span>
            </button>
            {showPlatformVolume && (
              <div className="bg-transparent overflow-hidden flex flex-col z-0 mt-0">
                <div className={LAYOUT.outerP}>
                  <div className={LAYOUT.listSpaceY}>
                    {cryptoPools.length === 0 ? (
                      <div className="text-sm text-gray-500 dark:text-gray-400">No platform pools configured</div>
                    ) : (
                      cryptoPools.map((p, i) => {
                        const addr = (p.address || '').toLowerCase();
                        const perPoolVal = poolVolumeMap ? (addr in poolVolumeMap ? poolVolumeMap[addr] : null) : null;
                        const display = typeof perPoolVal === 'number' ? formatUsd(perPoolVal, 0) : 'N/A';
                        return (
                          <div key={`${p.network}-${p.name}-${i}`} className={`${LAYOUT.itemPy} flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors`}>
                            <div className={`flex items-center ${LAYOUT.itemGap}`}>
                              <ChainIcon network={p.network} alt={p.network} />
                              <div className="text-base font-medium text-gray-900 dark:text-white">{p.name}</div>
                            </div>
                            <div className="text-base font-mono font-bold text-gray-900 dark:text-white"><span className="text-sm text-gray-900 dark:text-white">{display}</span></div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Column 2: Burned (top) + Platform Volume (below) */}
        <div className="flex flex-col gap-6">
          <div className="isolate bg-white/95 dark:bg-slate-800/95 rounded-2xl border border-gray-100/90 dark:border-slate-700 shadow-sm overflow-hidden flex flex-col relative">
            <div className="pointer-events-none absolute inset-0 -z-20 bg-pink-50/30 dark:bg-pink-950/14" />
            <CardAtmosphere accentClass="bg-pink-400" />
            <button
              ref={burnedCardRef}
              onClick={() => setShowBurnAddresses(s => !s)}
              aria-expanded={showBurnAddresses}
              className={`text-left bg-transparent px-6 pt-8 pb-8 flex flex-col justify-between relative overflow-visible z-20 min-h-[140px] transition-[filter] duration-200 hover:brightness-[1.01] ${
                showBurnAddresses
                  ? 'rounded-t-2xl border-b border-gray-100/80 dark:border-slate-700/80'
                  : 'rounded-2xl'
              }`}
            >
              <CardRail gradientClass="from-pink-400 via-fuchsia-300 to-rose-300" roundedClass="rounded-t-2xl" />
              <p className="text-sm font-semibold text-teal-500 dark:text-teal-400 text-center">Total Tokens Burned</p>
              <div className="flex-1 flex items-center justify-center">
                <div className="relative inline-block pointer-events-none">
                  <span ref={burnedNumberRef} className="text-3xl font-bold text-gray-900 dark:text-white whitespace-nowrap">
                    {formatValue(stats.totalBurned, 0)}
                  </span>
                  <span className="absolute left-full top-1/2 transform -translate-y-1/2 ml-1">
                    {burnedPct === null ? (
                      <span className="text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">N/A</span>
                    ) : (
                      <span className="text-sm font-medium text-red-600 dark:text-[#ff3b30] bg-red-100 dark:bg-red-950/40 px-2 py-0.5 rounded-full border border-red-200 dark:border-red-900/50 whitespace-nowrap">
                        {burnedPct.toFixed(2)}%
                      </span>
                    )}
                  </span>
                </div>
              </div>

              <span className={`absolute left-1/2 -translate-x-1/2 bottom-2 ${showBurnAddresses ? 'rotate-180' : ''}`} aria-hidden>
                <svg className="w-4 h-4 text-gray-400 dark:text-gray-300" viewBox="0 0 20 20" fill="currentColor"><path d="M5.23 7.21a.75.75 0 011.06-.02L10 10.88l3.71-3.69a.75.75 0 111.06 1.06l-4.24 4.22a.75.75 0 01-1.06 0L5.25 8.25a.75.75 0 01-.02-1.04z"/></svg>
              </span>
            </button>
            {showBurnAddresses && (
              <div className="bg-transparent overflow-hidden flex flex-col z-0 mt-0">
                <div className={LAYOUT.outerP}>
                  <div className={LAYOUT.listSpaceY}>
                    {(stats.burnAddresses || []).map((burn) => {
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
                      <div key={`${burn.network}-${burn.address}`} className={`${LAYOUT.itemPy} hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors`}> 
                        <div className={`flex items-center justify-between ${LAYOUT.itemGap}`}>
                          <div className={`flex items-center ${LAYOUT.itemGap}`}>
                            <ChainIcon network={burn.network} alt={networkLabel} />
                            <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="text-base text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300 font-mono">
                              {formatAddress(burn.address)}
                            </a>
                          </div>
                          <div className="w-20 sm:w-28 text-right text-base font-mono font-bold text-gray-900 dark:text-white">{formatValue(burn.balance)}</div>
                        </div>
                      </div>
                    );
                  })}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="isolate bg-white/95 dark:bg-slate-800/95 rounded-2xl border border-gray-100/90 dark:border-slate-700 shadow-sm overflow-hidden flex flex-col relative">
            <div className="pointer-events-none absolute inset-0 -z-20 bg-amber-50/32 dark:bg-amber-950/15" />
            <CardAtmosphere accentClass="bg-amber-300" />
            <button
              onClick={() => setShowLaunchpadDeals(s => !s)}
              aria-expanded={showLaunchpadDeals}
              className={`text-left bg-transparent px-6 pt-8 pb-8 flex flex-col justify-between relative overflow-visible z-20 min-h-[140px] transition-[filter] duration-200 hover:brightness-[1.01] ${
                showLaunchpadDeals
                  ? 'rounded-t-2xl border-b border-gray-100/80 dark:border-slate-700/80'
                  : 'rounded-2xl'
              }`}
            >
              <CardRail gradientClass="from-amber-400 via-orange-300 to-yellow-300" roundedClass="rounded-t-2xl" />
              <p className="text-sm font-semibold text-teal-500 dark:text-teal-400 text-center">Launchpad Funds Raised</p>
              <div className="flex-1 flex items-center justify-center">
                <span className="text-3xl font-bold text-gray-900 dark:text-white">
                  {formatUsd(tvlLaunchpadVal, 0)}
                </span>
              </div>

              <span className={`absolute left-1/2 -translate-x-1/2 bottom-2 ${showLaunchpadDeals ? 'rotate-180' : ''}`} aria-hidden>
                <svg className="w-4 h-4 text-gray-400 dark:text-gray-300" viewBox="0 0 20 20" fill="currentColor"><path d="M5.23 7.21a.75.75 0 011.06-.02L10 10.88l3.71-3.69a.75.75 0 111.06 1.06l-4.24 4.22a.75.75 0 01-1.06 0L5.25 8.25a.75.75 0 01-.02-1.04z"/></svg>
              </span>
            </button>
            {showLaunchpadDeals && (
              <div className="bg-transparent overflow-hidden flex flex-col z-0 mt-0">
                <div className={LAYOUT.outerP}>
                  <div className={LAYOUT.listSpaceY}>
                    {publicDeals.map((d, i) => {
                      // fallback inference for network in case JSON/config is missing it
                      const inferNetwork = (name: string) => {
                        const n = (name || '').toLowerCase();
                        if (n.includes('tempo')) return 'base';
                        if (n.includes('ckgp') || n.includes('sea') || n.includes('tau')) return 'polygon';
                        return 'ethereum';
                      };
                      const network = d.network || inferNetwork(d.name);
                      return (
                        <div key={`${d.name}-${i}`} className={`${LAYOUT.itemPy} flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors`}>
                          <div className={`flex items-center ${LAYOUT.itemGap}`}>
                            <ChainIcon network={network} alt={network} />
                            <div className="text-base font-medium text-gray-900 dark:text-white">{d.name}</div>
                          </div>
                          <div className="text-base font-mono font-bold text-gray-900 dark:text-white">{formatUsd(toFiniteNumberOrNull(d.value), 0)}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Column 3: TVL (single column) */}
        <div className="flex flex-col gap-6">
          <div className="isolate bg-white/95 dark:bg-slate-800/95 rounded-2xl border border-gray-100/90 dark:border-slate-700 shadow-sm overflow-hidden flex flex-col relative">
            <div className="pointer-events-none absolute inset-0 -z-20 bg-cyan-50/30 dark:bg-cyan-950/14" />
            <CardAtmosphere accentClass="bg-cyan-400" />
            <button
              onClick={() => setShowPlatformNumbers(s => !s)}
              aria-expanded={showPlatformNumbers}
              className={`text-left bg-transparent px-6 pt-8 pb-8 flex flex-col justify-between relative overflow-visible z-20 min-h-[140px] transition-[filter] duration-200 hover:brightness-[1.01] ${
                showPlatformNumbers
                  ? 'rounded-t-2xl border-b border-gray-100/80 dark:border-slate-700/80'
                  : 'rounded-2xl'
              }`}
            >
              <CardRail gradientClass="from-cyan-400 via-sky-300 to-teal-300" roundedClass="rounded-t-2xl" />
              <p className="text-sm font-semibold text-teal-500 dark:text-teal-400 text-center">Total Value Locked</p>
              <div className="flex-1 flex items-center justify-center">
                <span className="text-3xl font-bold text-gray-900 dark:text-white">
                  {formatUsd(totalTvl, 0)}
                </span>
              </div>

              <span className={`absolute left-1/2 -translate-x-1/2 bottom-2 ${showPlatformNumbers ? 'rotate-180' : ''}`} aria-hidden>
                <svg className="w-4 h-4 text-gray-400 dark:text-gray-300" viewBox="0 0 20 20" fill="currentColor"><path d="M5.23 7.21a.75.75 0 011.06-.02L10 10.88l3.71-3.69a.75.75 0 111.06 1.06l-4.24 4.22a.75.75 0 01-1.06 0L5.25 8.25a.75.75 0 01-.02-1.04z"/></svg>
              </span>
            </button>
            {showPlatformNumbers && (
              <div className="bg-transparent overflow-hidden flex flex-col z-0 mt-0">
                <div className="p-4">
                  {warnings && warnings.length > 0 && (
                    <div className="text-xs text-yellow-600 bg-yellow-50 px-2 py-1 rounded border border-yellow-200 text-right mb-2">{warnings.length} warning(s)</div>
                  )}

                  <div className={LAYOUT.listSpaceY}>
                    <div className={`${LAYOUT.sectionHeader} text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest text-center w-full`}>Private</div>
                    <div className={`${LAYOUT.itemPy} flex items-center justify-between`}>
                        <div className={`flex items-center ${LAYOUT.itemGap}`}>
                          <ChainIcon network="blockchain" alt="" />
                          <div className={`${LAYOUT.verifiedText} text-gray-900 dark:text-white`}>Verified by <a href={privateEntry.verifiedBy.href} target="_blank" rel="noopener noreferrer" className="text-cyan-600 hover:underline dark:text-cyan-400">{privateEntry.verifiedBy.label}</a></div>
                        </div>
                        <div className={`${LAYOUT.valueText} font-mono font-bold text-gray-900 dark:text-white`}>{formatUsd(tvlPrivateVal, 0)}</div>
                      </div>

                    {Object.entries(poolsByType).map(([type, items]) => (
                        <div key={type}>
                          <div className={`${LAYOUT.sectionHeader} text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest text-center w-full`}>{TYPE_LABELS[type] || type}</div>
                            <div className={LAYOUT.listSpaceY}>
                              {items.map((p, i) => (
                                <div key={`${p.network}-${p.name}-${i}`} className={`${LAYOUT.itemPy} flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors`}>
                                  <div className={`flex items-center ${LAYOUT.itemGap}`}>
                                    <ChainIcon network={p.network} alt={p.network} />
                                    <div className="text-base font-medium text-gray-900 dark:text-white">{p.name}</div>
                                  </div>
                                  <div className="text-base font-mono font-bold text-gray-900 dark:text-white">{formatUsd(toFiniteNumberOrNull(p.value), 0)}</div>
                                </div>
                              ))}
                            </div>
                        </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Panels are rendered inline beneath each card so they stay attached and only push content in their column */}

    </div>
  );
}

