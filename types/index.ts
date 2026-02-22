export interface Transaction {
  hash: string;
  from: string;
  to: string;
  value: string;
  gasPrice: string;
  gasUsed?: string;
  blockNumber: number;
  timestamp: number;
  status: 'pending' | 'success' | 'failed';
}

export interface BlockchainStats {
  totalTransactions: number;
  averageGasPrice: string;
  totalValue: string;
  successRate: number;
}

export interface FilterOptions {
  status?: 'pending' | 'success' | 'failed';
  minValue?: string;
  maxValue?: string;
}

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
