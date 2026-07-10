import type { ChainNetwork } from '../types';

export type PrefetchedOnchainReads = ReadonlyMap<string, string | null>;

export function poolReserveReadKey(network: ChainNetwork, poolAddress: string): string {
  return `reserves:${network}:${poolAddress.toLowerCase()}`;
}

export function burnBalanceReadKey(
  network: ChainNetwork,
  tokenAddress: string,
  holderAddress: string,
): string {
  return `balance:${network}:${tokenAddress.toLowerCase()}:${holderAddress.toLowerCase()}`;
}
