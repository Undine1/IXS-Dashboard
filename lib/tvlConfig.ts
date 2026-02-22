import { TvlPrivateEntry, TvlPublicDeal } from '@/types';

export const PRIVATE_ENTRY: TvlPrivateEntry = {
  label: 'Private',
  value: 88450000,
  verifiedBy: { label: 'RWA.IO', href: 'https://app.rwa.io/project/ixs-finance?tab=Project-Token' },
};

export const PUBLIC_DEALS: TvlPublicDeal[] = [
  { name: 'Tempo Fund', value: 500058, decimals: 0, network: 'base' },
  { name: 'CKGP', value: 515004.5, decimals: 2, network: 'polygon' },
  { name: 'Sea Solar Series 1', value: 50000, decimals: 0, network: 'polygon' },
  { name: 'Tau Digital', value: 41052.26, decimals: 2, network: 'polygon' },
];

export const TYPE_LABELS: Record<string, string> = {
  Crypto: 'Crypto Pools',
  RWA: 'RWA Pools',
};

const TVL_CONFIG = {
  PRIVATE_ENTRY,
  PUBLIC_DEALS,
  TYPE_LABELS,
};

export default TVL_CONFIG;
