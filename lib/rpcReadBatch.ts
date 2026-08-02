import type { ChainNetwork } from '../types';
import { executeMulticall3, type Multicall3Call, type Multicall3Result } from './multicall3';
import type { PrefetchedOnchainReads } from './onchainReadKeys';
import { sleep } from './rpc';

export type TaggedMulticall3Call = Multicall3Call & { key: string };
export type Multicall3ReadGroups = Record<ChainNetwork, TaggedMulticall3Call[]>;

type PrefetchMulticall3ReadsOptions = {
  // Snapshot refreshes record a failed subcall as null so last-known-good
  // section merging remains authoritative. Live reads omit it and use the
  // existing individual RPC path instead.
  recordFailedSubcalls?: boolean;
  logContext: string;
  execute?: (
    network: ChainNetwork,
    calls: Multicall3Call[],
  ) => Promise<Multicall3Result[]>;
  wait?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
};

const NETWORKS: ChainNetwork[] = ['ethereum', 'polygon', 'base'];

export function createMulticall3ReadGroups(): Multicall3ReadGroups {
  return { ethereum: [], polygon: [], base: [] };
}

export async function prefetchMulticall3Reads(
  grouped: Multicall3ReadGroups,
  options: PrefetchMulticall3ReadsOptions,
): Promise<PrefetchedOnchainReads> {
  const execute = options.execute || executeMulticall3;
  const wait = options.wait || sleep;
  const warn = options.warn || ((message: string) => console.warn(message));
  const prefetched = new Map<string, string | null>();
  let sentAny = false;

  for (const network of NETWORKS) {
    const taggedCalls = grouped[network];
    if (taggedCalls.length === 0) continue;
    if (sentAny) await wait(100);
    sentAny = true;

    try {
      const results = await execute(network, taggedCalls);
      results.forEach((result, index) => {
        const key = taggedCalls[index].key;
        if (result.success) {
          prefetched.set(key, result.returnData);
        } else if (options.recordFailedSubcalls) {
          prefetched.set(key, null);
        }
      });
    } catch (error) {
      // An absent chain makes callers use their proven individual provider
      // failover path. This is intentionally different from a recorded null.
      warn(
        `[${options.logContext}] ${network} Multicall3 failed; using individual reads: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return prefetched;
}
