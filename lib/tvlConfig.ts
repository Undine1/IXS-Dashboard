export const PRIVATE_ENTRY = {
  label: 'Private',
  value: 88450000,
  verifiedBy: { label: 'RWA.IO', href: 'https://app.rwa.io/project/ixs-finance?tab=Project-Token' },
};

export const PUBLIC_DEALS = [
  { name: 'Tempo Fund', value: 500058, decimals: 0 },
  { name: 'CKGP', value: 515004.5, decimals: 2 },
  { name: 'Sea Solar Series 1', value: 50000, decimals: 0 },
  { name: 'Tau Digital', value: 41052.26, decimals: 2 },
];

export const TYPE_LABELS: Record<string, string> = {
  Crypto: 'Crypto Pools',
  RWA: 'RWA Pools',
};

export default {
  PRIVATE_ENTRY,
  PUBLIC_DEALS,
  TYPE_LABELS,
};
