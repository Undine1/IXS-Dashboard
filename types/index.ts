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
// Legacy IXS accounting remains in its original denomination. Pool networks
// are separate because native Robinhood IXS uses a 1:10 redenomination.
export type PoolNetwork = ChainNetwork | 'robinhood';

export interface Pool {
  type: string;
  name: string;
  address: string;
  network: PoolNetwork;
  value?: number | null;
  priceSource?: boolean;
  tokenContract?: string;
  protocol?: 'uniswap-v4';
  poolManager?: string;
  explorerUrl?: string;
  valuation?: 'liquidity-principal';
  observedAt?: string;
  volume24hUsd?: number | null;
  volumeSource?: string;
  tokenPriceUsd?: number;
  priceBasis?: 'migration-1-to-10';
}

export interface PoolsApiResponse {
  pools: Pool[];
  warnings?: string[];
  debug?: unknown;
}

export interface VaultTvl {
  name: string;
  address: string;
  network: 'avalanche';
  valueUsd: number | null;
  navUpdatedAt: string | null;
}

export interface VaultTvlResponse {
  vaults: VaultTvl[];
  totalValueUsd: number | null;
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
