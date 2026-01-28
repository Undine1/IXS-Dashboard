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
  balance: string;
  label: string;
  network: 'ethereum' | 'polygon' | 'base';
}

export interface TokenBurnStats {
  totalBurned: string;
  burnAddresses: BurnAddress[];
  lastUpdated: number;
}
