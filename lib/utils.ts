const LOCALE = 'en-US';

export function formatAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatValue(value: string | bigint, decimals: number = 2): string {
  try {
    const bigValue = typeof value === 'string' ? BigInt(value) : value;
    const numberValue = Number(bigValue) / 1e18;
    return numberValue.toLocaleString(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  } catch {
    return '0';
  }
}

export function formatUsd(value: number | string, decimals: number = 2): string {
  try {
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (Number.isNaN(num) || !isFinite(num)) return '$0.00';
    return `$${num.toLocaleString(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  } catch {
    return '$0.00';
  }
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString(LOCALE);
}

export function formatNumber(value: number | string, decimals: number = 0): string {
  try {
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (Number.isNaN(num) || !isFinite(num)) return '0';
    return num.toLocaleString(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  } catch {
    return '0';
  }
}
