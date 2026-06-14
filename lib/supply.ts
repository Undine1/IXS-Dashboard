// Single source of truth for the IXS max/total supply, shared by the
// dashboard UI and the public /metrics route so the two can never drift.
// Override via TOTAL_SUPPLY (server) or NEXT_PUBLIC_TOTAL_SUPPLY (server +
// client bundle); the legacy MAX_SUPPLY names are honored for compatibility.

export const DEFAULT_TOTAL_SUPPLY = 180_000_000;

export function getTotalSupply(): number {
  const fromEnv =
    process.env.TOTAL_SUPPLY ??
    process.env.NEXT_PUBLIC_TOTAL_SUPPLY ??
    process.env.MAX_SUPPLY ??
    process.env.NEXT_PUBLIC_MAX_SUPPLY;
  const parsed = typeof fromEnv === 'number' ? fromEnv : Number(fromEnv);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOTAL_SUPPLY;
}
