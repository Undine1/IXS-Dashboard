const LOCALE = 'en-US';

export function formatAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatValue(value: string | bigint | null | undefined, decimals: number = 2): string {
  try {
    if (value === null || typeof value === 'undefined' || value === '') return 'N/A';
    const bigValue = typeof value === 'string' ? BigInt(value) : value;
    const numberValue = Number(bigValue) / 1e18;
    if (Number.isNaN(numberValue) || !Number.isFinite(numberValue)) return 'N/A';
    return numberValue.toLocaleString(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  } catch {
    return 'N/A';
  }
}

export function formatUsd(value: number | string | null | undefined, decimals: number = 2): string {
  try {
    if (value === null || typeof value === 'undefined' || value === '') return 'N/A';
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (Number.isNaN(num) || !isFinite(num)) return 'N/A';
    return `$${num.toLocaleString(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  } catch {
    return 'N/A';
  }
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString(LOCALE);
}

export function formatNumber(value: number | string | null | undefined, decimals: number = 0): string {
  try {
    if (value === null || typeof value === 'undefined' || value === '') return 'N/A';
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (Number.isNaN(num) || !isFinite(num)) return 'N/A';
    return num.toLocaleString(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  } catch {
    return 'N/A';
  }
}
