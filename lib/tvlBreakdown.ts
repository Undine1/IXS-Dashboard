import type { Pool, VaultTvlResponse } from '../types';

function roundedValue(value: number | null | undefined, increment = 1): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value / increment) * increment;
}

// The card total and its rows share the same display precision. Keep the raw
// API valuations intact; only the UI rounds pool/vault rows to whole dollars.
export function getTvlBreakdown(
  privateValue: number | null,
  pools: Pool[],
  vault: VaultTvlResponse | null | undefined,
) {
  // The private entry is displayed in millions with two decimal places.
  const displayedPrivate = roundedValue(privateValue, 10_000);
  const displayedPools = pools.map((pool) => ({ ...pool, value: roundedValue(pool.value) }));
  const displayedVaults = (vault?.vaults ?? []).map((entry) => ({
    ...entry,
    valueUsd: roundedValue(entry.valueUsd),
  }));
  // Each visible row contributes once. Neither underlying Ethereum pools nor
  // the separate vault aggregate is added on top of its displayed rows.
  const values = [displayedPrivate, ...displayedPools.map((pool) => pool.value),
    ...displayedVaults.map((entry) => entry.valueUsd)];
  const sum = values.reduce<number>((total, value) => total + (value ?? 0), 0);
  const complete = displayedPools.length > 0 && displayedVaults.length > 0 &&
    values.every((value) => value !== null) && Number.isFinite(sum);

  return {
    privateValue: displayedPrivate,
    pools: displayedPools,
    vaults: displayedVaults,
    total: complete ? sum : null,
  };
}
