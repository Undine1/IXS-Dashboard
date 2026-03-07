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

interface HolderRankingRow {
  rank: number;
  holder: string;
  chainsHolding: number;
  totalIxs: string;
  label?: string | null;
}

interface HolderRankingsResponse {
  ok?: boolean;
  rows?: HolderRankingRow[];
  totalRowCount?: number;
  lastRefreshed?: string | null;
  error?: string;
}

function toFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatHolderAddress(address: string): string {
  if (!address || address.length <= 10) return address;
  if (address.startsWith('0x')) {
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  }
  return `${address.slice(0, 2)}...${address.slice(-4)}`;
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

type CardSection = 'all' | 'statistics' | 'token';

interface CollapsiblePanelProps {
  open: boolean;
  children: React.ReactNode;
}

function ChainIcon({ network, alt }: ChainIconProps) {
  const src = `/images/chains/${network}.png`;

  return (
    <Image
      src={src}
      alt={alt}
      width={20}
      height={20}
      className="w-5 h-5 object-contain"
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

function CollapsiblePanel({ open, children }: CollapsiblePanelProps) {
  return (
    <div
      className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0 pointer-events-none'
      }`}
    >
      <div className="overflow-hidden">
        <div
          className={`transform transition-transform duration-300 ease-out ${
            open ? 'translate-y-0' : '-translate-y-1'
          }`}
        >
          {children}
        </div>
      </div>
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
  const [showHolderRankings, setShowHolderRankings] = useState<boolean>(false);
  const [cardSection, setCardSection] = useState<CardSection>('all');
  const [holderSearch, setHolderSearch] = useState<string>('');
  const [holderRows, setHolderRows] = useState<HolderRankingRow[]>([]);
  const [holderLoading, setHolderLoading] = useState<boolean>(true);
  const [holderError, setHolderError] = useState<string | null>(null);
  const [copiedHolderAddress, setCopiedHolderAddress] = useState<string | null>(null);
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

  useEffect(() => {
    let cancelled = false;

    const fetchHolderRankings = async () => {
      setHolderLoading(true);
      setHolderError(null);
      try {
        const response = await fetch('/api/holderRankings', { cache: 'no-store' });
        const payload = (await response.json()) as HolderRankingsResponse;
        if (!response.ok || !payload.ok) {
          const message = payload?.error || 'Unable to load holder rankings';
          if (!cancelled) setHolderError(message);
          if (!cancelled) setHolderRows([]);
          return;
        }

        if (!cancelled) {
          const rows = Array.isArray(payload.rows) ? payload.rows : [];
          setHolderRows(rows);
        }
      } catch {
        if (!cancelled) {
          setHolderError('Unable to load holder rankings');
          setHolderRows([]);
        }
      } finally {
        if (!cancelled) setHolderLoading(false);
      }
    };

    fetchHolderRankings();
    const interval = setInterval(fetchHolderRankings, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const holderSearchNormalized = holderSearch.trim().toLowerCase();
  const visibleHolderRows = holderSearchNormalized
    ? holderRows.filter((row) => {
      const label = typeof row.label === 'string' ? row.label.toLowerCase() : '';
      return (
        row.holder.includes(holderSearchNormalized) ||
        label.includes(holderSearchNormalized)
      );
    })
    : holderRows;
  const holderRowsVisible = 10;
  const holderRowHeightPx = 56;
  const holderListMaxHeightPx = holderRowsVisible * holderRowHeightPx;

  const focusOptions: Array<{ value: CardSection; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'statistics', label: 'Statistics' },
    { value: 'token', label: 'Token' },
  ];

  const showSupplyCard = cardSection === 'all' || cardSection === 'token';
  const showBurnedCard = cardSection === 'all' || cardSection === 'token';
  const showHoldersCard = cardSection === 'all' || cardSection === 'token';
  const showPlatformVolumeCard = cardSection === 'all' || cardSection === 'statistics';
  const showLaunchpadCard = cardSection === 'all' || cardSection === 'statistics';
  const showTvlCard = cardSection === 'all' || cardSection === 'statistics';

  const showColumnOne = showSupplyCard || showPlatformVolumeCard;
  const showColumnTwo = showBurnedCard || showLaunchpadCard;
  const showColumnThree = showTvlCard || showHoldersCard;
  const activeColumnCount = [showColumnOne, showColumnTwo, showColumnThree].filter(Boolean).length;
  const cardGridColumnsClass = activeColumnCount <= 1 ? 'md:grid-cols-1' : activeColumnCount === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3';
  const insetListClass = 'rounded-xl border border-gray-100 bg-white/70 dark:border-slate-700 dark:bg-slate-900/30';
  const insetRowClass = 'box-border flex h-11 items-center justify-between gap-3 border-b border-gray-100 px-3 text-sm hover:bg-gray-50/90 last:border-b-0 dark:border-slate-700/70 dark:hover:bg-slate-800/60';

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
  const holderCopyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const supplyCardRef = useRef<HTMLDivElement | null>(null);
  const supplyNumberRef = useRef<HTMLSpanElement | null>(null);
  // Title centering refs for the supply card (center text, position checkmark separately)
  const supplyTitleRef = useRef<HTMLParagraphElement | null>(null);
  const supplyTitleTextRef = useRef<HTMLSpanElement | null>(null);
  const [supplyCheckLeft, setSupplyCheckLeft] = useState<string | null>(null);
  const holderTableRef = useRef<HTMLDivElement | null>(null);
  const [holderScrollbarWidth, setHolderScrollbarWidth] = useState<number>(0);

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

  useLayoutEffect(() => {
    function syncHolderHeaderWidth() {
      window.requestAnimationFrame(() => {
        const container = holderTableRef.current;
        if (!container) {
          setHolderScrollbarWidth(0);
          return;
        }

        const styles = window.getComputedStyle(container);
        const borderLeft = Number.parseFloat(styles.borderLeftWidth) || 0;
        const borderRight = Number.parseFloat(styles.borderRightWidth) || 0;
        const scrollbarWidth = container.offsetWidth - container.clientWidth - borderLeft - borderRight;
        const normalized = Math.max(0, Math.round(scrollbarWidth));
        setHolderScrollbarWidth((current) => (current === normalized ? current : normalized));
      });
    }

    syncHolderHeaderWidth();
    window.addEventListener('resize', syncHolderHeaderWidth);
    return () => window.removeEventListener('resize', syncHolderHeaderWidth);
  }, [showHolderRankings, visibleHolderRows.length, holderLoading]);

  useEffect(() => {
    return () => {
      if (holderCopyResetTimeoutRef.current) {
        clearTimeout(holderCopyResetTimeoutRef.current);
      }
    };
  }, []);

  async function handleCopyHolderAddress(address: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedHolderAddress(address);
      if (holderCopyResetTimeoutRef.current) {
        clearTimeout(holderCopyResetTimeoutRef.current);
      }
      holderCopyResetTimeoutRef.current = setTimeout(() => {
        setCopiedHolderAddress((current) => (current === address ? null : current));
      }, 1200);
    } catch {
      // no-op: keep UI unchanged if clipboard write is unavailable
    }
  }

  if (!stats || !Array.isArray(stats.burnAddresses) || stats.burnAddresses.length === 0) {
    return (
      <div className="p-6 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-700">
        <p>No burn statistics available yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      
      <div className="rounded-2xl border border-gray-200/80 bg-white/70 p-2 dark:border-slate-700/70 dark:bg-slate-900/35">
        <div className="modern-scrollbar flex gap-2 overflow-x-auto pb-1">
          {focusOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setCardSection(option.value)}
              className={`shrink-0 rounded-xl border px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition-colors ${
                cardSection === option.value
                  ? 'border-slate-800 bg-slate-800 text-white dark:border-slate-200 dark:bg-slate-100 dark:text-slate-900'
                  : 'border-gray-200 bg-white/80 text-gray-600 hover:bg-gray-100 dark:border-slate-700 dark:bg-slate-800/70 dark:text-gray-300 dark:hover:bg-slate-700/90'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* --- Top Metrics Grid --- */}
      <div className={`grid grid-cols-1 ${cardGridColumnsClass} gap-6 relative`}>
        {/* Column 1: Supply (top) + Launchpad (below) — stacking ensures panels push only this column */}
        {showColumnOne && (
        <div className="flex flex-col gap-6">
          {showSupplyCard && (
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
          )}

          {showPlatformVolumeCard && (
          <div className="isolate bg-white/95 dark:bg-slate-800/95 rounded-2xl border border-gray-100/90 dark:border-slate-700 shadow-sm overflow-hidden flex flex-col relative">
            <div className="pointer-events-none absolute inset-0 -z-20 bg-indigo-50/30 dark:bg-indigo-950/14" />
            <CardAtmosphere accentClass="bg-indigo-400" />
            <button
              onClick={() => setShowPlatformVolume(s => !s)}
              aria-expanded={showPlatformVolume}
              className={`text-left bg-transparent px-6 pt-8 pb-8 flex flex-col justify-between relative overflow-visible z-20 min-h-[140px] transition-[filter] duration-200 hover:brightness-[1.01] ${
                showPlatformVolume
                  ? 'rounded-t-2xl'
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

              <span className={`absolute left-1/2 -translate-x-1/2 bottom-2 transition-transform duration-300 ${showPlatformVolume ? 'rotate-180' : ''}`} aria-hidden>
                <svg className="w-4 h-4 text-gray-400 dark:text-gray-300" viewBox="0 0 20 20" fill="currentColor"><path d="M5.23 7.21a.75.75 0 011.06-.02L10 10.88l3.71-3.69a.75.75 0 111.06 1.06l-4.24 4.22a.75.75 0 01-1.06 0L5.25 8.25a.75.75 0 01-.02-1.04z"/></svg>
              </span>
            </button>
            <CollapsiblePanel open={showPlatformVolume}>
              <div className="bg-transparent overflow-hidden flex flex-col z-0 mt-0">
                <div className="p-4">
                  <div className={insetListClass}>
                    <div>
                      {cryptoPools.length === 0 ? (
                        <div className="p-4 text-sm text-gray-500 dark:text-gray-400">No platform pools configured</div>
                      ) : (
                        cryptoPools.map((p, i) => {
                          const addr = (p.address || '').toLowerCase();
                          const perPoolVal = poolVolumeMap ? (addr in poolVolumeMap ? poolVolumeMap[addr] : null) : null;
                          const display = typeof perPoolVal === 'number' ? formatUsd(perPoolVal, 0) : 'N/A';
                          return (
                            <div key={`${p.network}-${p.name}-${i}`} className={insetRowClass}>
                              <div className={`flex items-center ${LAYOUT.itemGap}`}>
                                <ChainIcon network={p.network} alt={p.network} />
                                <div className="text-sm font-medium text-gray-900 dark:text-white">{p.name}</div>
                              </div>
                              <div className="text-sm font-mono font-bold text-gray-900 dark:text-white">{display}</div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </CollapsiblePanel>
          </div>
          )}
        </div>
        )}

        {/* Column 2: Burned (top) + Platform Volume (below) */}
        {showColumnTwo && (
        <div className="flex flex-col gap-6">
          {showBurnedCard && (
          <div className="isolate bg-white/95 dark:bg-slate-800/95 rounded-2xl border border-gray-100/90 dark:border-slate-700 shadow-sm overflow-hidden flex flex-col relative">
            <div className="pointer-events-none absolute inset-0 -z-20 bg-pink-50/30 dark:bg-pink-950/14" />
            <CardAtmosphere accentClass="bg-pink-400" />
            <button
              ref={burnedCardRef}
              onClick={() => setShowBurnAddresses(s => !s)}
              aria-expanded={showBurnAddresses}
              className={`text-left bg-transparent px-6 pt-8 pb-8 flex flex-col justify-between relative overflow-visible z-20 min-h-[140px] transition-[filter] duration-200 hover:brightness-[1.01] ${
                showBurnAddresses
                  ? 'rounded-t-2xl'
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

              <span className={`absolute left-1/2 -translate-x-1/2 bottom-2 transition-transform duration-300 ${showBurnAddresses ? 'rotate-180' : ''}`} aria-hidden>
                <svg className="w-4 h-4 text-gray-400 dark:text-gray-300" viewBox="0 0 20 20" fill="currentColor"><path d="M5.23 7.21a.75.75 0 011.06-.02L10 10.88l3.71-3.69a.75.75 0 111.06 1.06l-4.24 4.22a.75.75 0 01-1.06 0L5.25 8.25a.75.75 0 01-.02-1.04z"/></svg>
              </span>
            </button>
            <CollapsiblePanel open={showBurnAddresses}>
              <div className="bg-transparent overflow-hidden flex flex-col z-0 mt-0">
                <div className="p-4">
                  <div className={insetListClass}>
                    <div>
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
                        <div key={`${burn.network}-${burn.address}`} className={insetRowClass}> 
                          <div className={`flex items-center ${LAYOUT.itemGap}`}>
                            <ChainIcon network={burn.network} alt={networkLabel} />
                            <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300 font-mono">
                              {formatAddress(burn.address)}
                            </a>
                          </div>
                          <div className="w-20 sm:w-28 text-right text-sm font-mono font-bold text-gray-900 dark:text-white">{formatValue(burn.balance)}</div>
                        </div>
                      );
                    })}
                    </div>
                  </div>
                </div>
              </div>
            </CollapsiblePanel>
          </div>
          )}

          {showLaunchpadCard && (
          <div className="isolate bg-white/95 dark:bg-slate-800/95 rounded-2xl border border-gray-100/90 dark:border-slate-700 shadow-sm overflow-hidden flex flex-col relative">
            <div className="pointer-events-none absolute inset-0 -z-20 bg-amber-50/32 dark:bg-amber-950/15" />
            <CardAtmosphere accentClass="bg-amber-300" />
            <button
              onClick={() => setShowLaunchpadDeals(s => !s)}
              aria-expanded={showLaunchpadDeals}
              className={`text-left bg-transparent px-6 pt-8 pb-8 flex flex-col justify-between relative overflow-visible z-20 min-h-[140px] transition-[filter] duration-200 hover:brightness-[1.01] ${
                showLaunchpadDeals
                  ? 'rounded-t-2xl'
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

              <span className={`absolute left-1/2 -translate-x-1/2 bottom-2 transition-transform duration-300 ${showLaunchpadDeals ? 'rotate-180' : ''}`} aria-hidden>
                <svg className="w-4 h-4 text-gray-400 dark:text-gray-300" viewBox="0 0 20 20" fill="currentColor"><path d="M5.23 7.21a.75.75 0 011.06-.02L10 10.88l3.71-3.69a.75.75 0 111.06 1.06l-4.24 4.22a.75.75 0 01-1.06 0L5.25 8.25a.75.75 0 01-.02-1.04z"/></svg>
              </span>
            </button>
            <CollapsiblePanel open={showLaunchpadDeals}>
              <div className="bg-transparent overflow-hidden flex flex-col z-0 mt-0">
                <div className="p-4">
                  <div className={insetListClass}>
                    <div>
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
                          <div key={`${d.name}-${i}`} className={insetRowClass}>
                            <div className={`flex items-center ${LAYOUT.itemGap}`}>
                              <ChainIcon network={network} alt={network} />
                              <div className="text-sm font-medium text-gray-900 dark:text-white">{d.name}</div>
                            </div>
                            <div className="text-sm font-mono font-bold text-gray-900 dark:text-white">{formatUsd(toFiniteNumberOrNull(d.value), 0)}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </CollapsiblePanel>
          </div>
          )}
        </div>
        )}

        {/* Column 3: TVL + Holder Rankings */}
        {showColumnThree && (
          <div className="flex flex-col gap-6">
            {showTvlCard && (
              <div className="isolate bg-white/95 dark:bg-slate-800/95 rounded-2xl border border-gray-100/90 dark:border-slate-700 shadow-sm overflow-hidden flex flex-col relative">
                <div className="pointer-events-none absolute inset-0 -z-20 bg-cyan-50/30 dark:bg-cyan-950/14" />
                <CardAtmosphere accentClass="bg-cyan-400" />
                <button
                  onClick={() => setShowPlatformNumbers(s => !s)}
                  aria-expanded={showPlatformNumbers}
                  className={`text-left bg-transparent px-6 pt-8 pb-8 flex flex-col justify-between relative overflow-visible z-20 min-h-[140px] transition-[filter] duration-200 hover:brightness-[1.01] ${
                    showPlatformNumbers
                      ? 'rounded-t-2xl'
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

                  <span className={`absolute left-1/2 -translate-x-1/2 bottom-2 transition-transform duration-300 ${showPlatformNumbers ? 'rotate-180' : ''}`} aria-hidden>
                    <svg className="w-4 h-4 text-gray-400 dark:text-gray-300" viewBox="0 0 20 20" fill="currentColor"><path d="M5.23 7.21a.75.75 0 011.06-.02L10 10.88l3.71-3.69a.75.75 0 111.06 1.06l-4.24 4.22a.75.75 0 01-1.06 0L5.25 8.25a.75.75 0 01-.02-1.04z"/></svg>
                  </span>
                </button>
                <CollapsiblePanel open={showPlatformNumbers}>
                  <div className="bg-transparent overflow-hidden flex flex-col z-0 mt-0">
                    <div className="p-4 space-y-3">
                      {warnings && warnings.length > 0 && (
                        <div className="text-xs text-yellow-700 bg-yellow-100/90 px-2 py-1 rounded border border-yellow-200 text-right dark:text-yellow-300 dark:bg-yellow-950/35 dark:border-yellow-800/60">{warnings.length} warning(s)</div>
                      )}

                      <div className="space-y-3">
                        <div className="py-1 text-center text-[11px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-300">
                          Private
                        </div>
                        <div className={insetListClass}>
                          <div className={insetRowClass}>
                            <div className={`flex items-center ${LAYOUT.itemGap}`}>
                              <ChainIcon network="blockchain" alt="" />
                              <div className="text-sm text-gray-900 dark:text-white">Verified by <a href={privateEntry.verifiedBy.href} target="_blank" rel="noopener noreferrer" className="text-cyan-600 hover:underline dark:text-cyan-400">{privateEntry.verifiedBy.label}</a></div>
                            </div>
                            <div className="text-sm font-mono font-bold text-gray-900 dark:text-white">{formatUsd(tvlPrivateVal, 0)}</div>
                          </div>
                        </div>

                        {Object.entries(poolsByType).map(([type, items]) => (
                          <div key={type} className="space-y-2">
                            <div className="py-1 text-center text-[11px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-300">
                              {TYPE_LABELS[type] || type}
                            </div>
                            <div className={insetListClass}>
                              {items.map((p, i) => (
                                <div key={`${p.network}-${p.name}-${i}`} className={insetRowClass}>
                                  <div className={`flex items-center ${LAYOUT.itemGap}`}>
                                    <ChainIcon network={p.network} alt={p.network} />
                                    <div className="text-sm font-medium text-gray-900 dark:text-white">{p.name}</div>
                                  </div>
                                  <div className="text-sm font-mono font-bold text-gray-900 dark:text-white">{formatUsd(toFiniteNumberOrNull(p.value), 0)}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </CollapsiblePanel>
              </div>
            )}

            {showHoldersCard && (
              <div className="isolate bg-white/95 dark:bg-slate-800/95 rounded-2xl border border-gray-100/90 dark:border-slate-700 shadow-sm overflow-hidden flex flex-col relative">
                <div className="pointer-events-none absolute inset-0 -z-20 bg-red-50/35 dark:bg-red-950/20" />
                <CardAtmosphere accentClass="bg-red-500" />
                <button
                  onClick={() => setShowHolderRankings((s) => !s)}
                  aria-expanded={showHolderRankings}
                  className={`text-left bg-transparent px-6 pt-8 pb-8 flex flex-col justify-between relative overflow-visible z-20 min-h-[140px] transition-[filter] duration-200 hover:brightness-[1.01] ${
                    showHolderRankings
                      ? 'rounded-t-2xl'
                      : 'rounded-2xl'
                  }`}
                >
                  <CardRail gradientClass="from-red-600 via-red-500 to-orange-400" roundedClass="rounded-t-2xl" />
                  <p className="text-sm font-semibold text-teal-500 dark:text-teal-400 text-center">Holder Rankings</p>
                  <div className="flex-1 flex items-center justify-center">
                    <span className="text-3xl font-bold text-gray-900 dark:text-white">
                      {holderLoading ? 'Syncing...' : 'Top 500'}
                    </span>
                  </div>

                  <span className={`absolute left-1/2 -translate-x-1/2 bottom-2 transition-transform duration-300 ${showHolderRankings ? 'rotate-180' : ''}`} aria-hidden>
                    <svg className="w-4 h-4 text-gray-400 dark:text-gray-300" viewBox="0 0 20 20" fill="currentColor"><path d="M5.23 7.21a.75.75 0 011.06-.02L10 10.88l3.71-3.69a.75.75 0 111.06 1.06l-4.24 4.22a.75.75 0 01-1.06 0L5.25 8.25a.75.75 0 01-.02-1.04z"/></svg>
                  </span>
                </button>
                <CollapsiblePanel open={showHolderRankings}>
                  <div className="bg-transparent overflow-hidden flex flex-col z-0 mt-0">
                    <div className="p-4 space-y-3">
                      {holderError ? (
                        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800/70 dark:bg-rose-950/25 dark:text-rose-300">
                          {holderError}
                        </div>
                      ) : null}

                      <div
                        className="grid grid-cols-12 items-center gap-2 pl-4 pr-4 py-2 text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-300"
                        style={{ paddingRight: `${16 + holderScrollbarWidth}px` }}
                      >
                        <span className="col-span-1 text-left" aria-hidden />
                        <span className="col-span-5 pl-5 text-left">holder</span>
                        <span className="col-span-6 text-right">tokens</span>
                      </div>

                      <div
                        ref={holderTableRef}
                        className="modern-scrollbar overflow-y-auto rounded-xl border border-gray-100 bg-white/70 dark:border-slate-700 dark:bg-slate-900/30"
                        style={{ maxHeight: `${holderListMaxHeightPx}px` }}
                      >
                        {holderLoading ? (
                          <div className="p-4 text-sm text-gray-500 dark:text-gray-400">Loading holder rankings...</div>
                        ) : visibleHolderRows.length === 0 ? (
                          <div className="p-4 text-sm text-gray-500 dark:text-gray-400">No holders found for that search.</div>
                        ) : (
                          <div>
                            {visibleHolderRows.map((row) => (
                              <div
                                key={`${row.rank}-${row.holder}`}
                                className="box-border grid min-h-14 grid-cols-12 items-center gap-2 border-b border-gray-100 px-4 py-2 text-sm hover:bg-gray-50/90 last:border-b-0 dark:border-slate-700/70 dark:hover:bg-slate-800/60"
                              >
                                <span className="col-span-1 text-left font-semibold tabular-nums text-gray-900 dark:text-gray-100">{row.rank}</span>
                                <button
                                  type="button"
                                  onClick={() => void handleCopyHolderAddress(row.holder)}
                                  title={copiedHolderAddress === row.holder ? 'Copied' : 'Click to copy full address'}
                                  aria-label={`Copy address ${row.holder}`}
                                  className={`col-span-5 w-full pl-5 text-left font-mono text-sm whitespace-nowrap transition-colors ${
                                    copiedHolderAddress === row.holder
                                      ? 'text-emerald-700 dark:text-emerald-300'
                                      : 'text-cyan-700 dark:text-cyan-300'
                                  }`}
                                >
                                  <span className="inline-flex items-baseline gap-2">
                                    <span className="shrink-0 font-mono text-sm text-current">
                                      {formatHolderAddress(row.holder)}
                                    </span>
                                    {row.label ? (
                                      <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                                        {row.label}
                                      </span>
                                    ) : null}
                                  </span>
                                </button>
                                <span className="col-span-6 w-full text-right font-mono font-bold text-gray-900 dark:text-white">{row.totalIxs}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <label className="block">
                        <span className="mb-1 block text-center text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-300">
                          Search Address
                        </span>
                        <input
                          type="text"
                          value={holderSearch}
                          onChange={(event) => setHolderSearch(event.target.value)}
                          placeholder="0x... or name"
                          className="w-full rounded-xl border border-gray-200 bg-white/90 px-3 py-2 text-sm font-mono text-gray-900 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-200/70 dark:border-slate-600 dark:bg-slate-900/70 dark:text-gray-100 dark:focus:border-cyan-400 dark:focus:ring-cyan-800/60"
                        />
                      </label>
                    </div>
                  </div>
                </CollapsiblePanel>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Panels are rendered inline beneath each card so they stay attached and only push content in their column */}

    </div>
  );
}

