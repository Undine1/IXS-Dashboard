// Pure helpers for decoding on-chain eth_call results into numbers.
// Extracted so the correctness-bearing math can be unit-tested in isolation.

export function normalizeAddressFromHex(hexResult: string): string {
  return `0x${hexResult.slice(-40)}`.toLowerCase();
}

export function parseHexInt(hexResult: string, label: string): number {
  const parsed = Number.parseInt(hexResult, 16);
  if (Number.isNaN(parsed)) {
    throw new Error(`invalid ${label} result`);
  }
  return parsed;
}

export function bigintToDecimalNumber(value: bigint, decimals: number, precision = 12): number {
  if (decimals <= 0) {
    return Number(value);
  }

  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const divisor = BigInt(10) ** BigInt(decimals);
  const integerPart = abs / divisor;
  const fractionalPart = (abs % divisor).toString().padStart(decimals, '0').slice(0, precision);
  const decimalString = `${negative ? '-' : ''}${integerPart.toString()}.${fractionalPart}`;
  const parsed = Number(decimalString);
  return Number.isFinite(parsed) ? parsed : 0;
}
