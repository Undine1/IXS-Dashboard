import type { ChainNetwork } from '../types';
import { getBurnBalanceReadRequests } from './burnStatsService';
import { executeMulticall3, type Multicall3Call } from './multicall3';
import {
  burnBalanceReadKey,
  poolReserveReadKey,
  type PrefetchedOnchainReads,
} from './onchainReadKeys';
import { POOLS } from './poolsConfig';
import { sleep } from './rpc';

type TaggedCall = Multicall3Call & { key: string };

const NETWORKS: ChainNetwork[] = ['ethereum', 'polygon', 'base'];

function balanceOfCallData(address: string): string {
  return `0x70a08231000000000000000000000000${address.slice(2).toLowerCase()}`;
}

export async function prefetchSnapshotRpcReads(): Promise<PrefetchedOnchainReads> {
  const grouped: Record<ChainNetwork, TaggedCall[]> = {
    ethereum: [],
    polygon: [],
    base: [],
  };
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

  const prefetched = new Map<string, string | null>();
  let sentAny = false;
  for (const network of NETWORKS) {
    const taggedCalls = grouped[network];
    if (taggedCalls.length === 0) continue;
    if (sentAny) await sleep(100);
    sentAny = true;

    try {
      const results = await executeMulticall3(network, taggedCalls);
      results.forEach((result, index) => {
        prefetched.set(taggedCalls[index].key, result.success ? result.returnData : null);
      });
    } catch (error) {
      // Leaving this chain absent makes the existing services use their proven
      // individual provider-failover path. A failed subcall, by contrast, is
      // recorded as null so section health and last-known-good merging remain
      // unchanged.
      console.warn(
        `[onchain-snapshot] ${network} Multicall3 failed; using individual reads: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return prefetched;
}
