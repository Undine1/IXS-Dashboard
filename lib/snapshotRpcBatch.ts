import { getBurnBalanceReadRequests } from './burnStatsService';
import {
  burnBalanceReadKey,
  type PrefetchedOnchainReads,
} from './onchainReadKeys';
import { POOLS } from './poolsConfig';
import { getPoolReadRequests } from './poolUsdPricing';
import {
  createMulticall3ReadGroups,
  prefetchMulticall3Reads,
  type Multicall3ReadGroups,
} from './rpcReadBatch';

function balanceOfCallData(address: string): string {
  return `0x70a08231000000000000000000000000${address.slice(2).toLowerCase()}`;
}

export function createSnapshotRpcReadGroups(): Multicall3ReadGroups {
  const grouped = createMulticall3ReadGroups();
  const seen = new Set<string>();

  for (const pool of POOLS) {
    for (const call of getPoolReadRequests(pool)) {
      if (seen.has(call.key)) continue;
      seen.add(call.key);
      grouped[pool.network].push(call);
    }
  }

  for (const request of getBurnBalanceReadRequests()) {
    const key = burnBalanceReadKey(
      request.network,
      request.tokenAddress,
      request.holderAddress,
    );
    if (seen.has(key)) continue;
    seen.add(key);
    grouped[request.network].push({
      key,
      target: request.tokenAddress,
      allowFailure: true,
      callData: balanceOfCallData(request.holderAddress),
    });
  }

  return grouped;
}

export async function prefetchSnapshotRpcReads(): Promise<PrefetchedOnchainReads> {
  const grouped = createSnapshotRpcReadGroups();

  return prefetchMulticall3Reads(grouped, {
    logContext: 'onchain-snapshot',
    recordFailedSubcalls: true,
  });
}
