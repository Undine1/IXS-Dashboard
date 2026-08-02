import { getBurnBalanceReadRequests } from './burnStatsService';
import {
  burnBalanceReadKey,
  poolReserveReadKey,
  type PrefetchedOnchainReads,
} from './onchainReadKeys';
import { POOLS } from './poolsConfig';
import {
  createMulticall3ReadGroups,
  prefetchMulticall3Reads,
} from './rpcReadBatch';

function balanceOfCallData(address: string): string {
  return `0x70a08231000000000000000000000000${address.slice(2).toLowerCase()}`;
}

export async function prefetchSnapshotRpcReads(): Promise<PrefetchedOnchainReads> {
  const grouped = createMulticall3ReadGroups();
  const seen = new Set<string>();

  for (const pool of POOLS) {
    const key = poolReserveReadKey(pool.network, pool.address);
    if (seen.has(key)) continue;
    seen.add(key);
    grouped[pool.network].push({
      key,
      target: pool.address,
      allowFailure: true,
      callData: '0x0902f1ac',
    });
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

  return prefetchMulticall3Reads(grouped, {
    logContext: 'onchain-snapshot',
    recordFailedSubcalls: true,
  });
}
