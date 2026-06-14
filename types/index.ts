export interface BurnAddress {
  address: string;
  balance: string | null;
  label: string;
  network: 'ethereum' | 'polygon' | 'base';
}

export interface TokenBurnStats {
  totalBurned: string | null;
  burnAddresses: BurnAddress[];
  lastUpdated: number;
}

export type ChainNetwork = 'ethereum' | 'polygon' | 'base';

export interface Pool {
  type: string;
  name: string;
  address: string;
  network: ChainNetwork;
  value?: number | null;
  priceSource?: boolean;
  tokenContract?: string;
}

export interface PoolsApiResponse {
  pools: Pool[];
  warnings?: string[];
  debug?: unknown;
}

export interface TvlPrivateEntry {
  label: string;
  value: number | null;
  verifiedBy: {
    label: string;
    href: string;
  };
}

export interface TvlPublicDeal {
  name: string;
  value: number;
  decimals?: number;
  network?: ChainNetwork;
}
