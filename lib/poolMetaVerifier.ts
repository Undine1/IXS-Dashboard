import type { ChainNetwork } from '@/types';
import type { PoolConfig, PoolMeta } from './poolsConfig';
import type { Multicall3Call, Multicall3Result } from './multicall3';

const TOKEN0_SELECTOR = '0x0dfe1681';
const TOKEN1_SELECTOR = '0xd21220a7';
const DECIMALS_SELECTOR = '0x313ce567';

type ResolvedRead<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

type LogicalRead<T> = {
  key: string;
  target: string;
  callData: string;
  decode: (value: string) => T;
  fallbackAttempts?: number;
};

type IndexedPool = {
  index: number;
  pool: PoolConfig;
  meta: PoolMeta;
};

export type PoolMetaVerificationRpc = {
  multicall: (
    network: ChainNetwork,
    calls: Multicall3Call[],
  ) => Promise<Multicall3Result[]>;
  ethCall: (
    network: ChainNetwork,
    target: string,
    callData: string,
  ) => Promise<string>;
};

export type PoolMetaVerificationResult = {
  pool: PoolConfig;
  status: 'ok' | 'drift' | 'unverified' | 'skipped';
  mismatches: string[];
  error?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function decodeAddressWord(value: string): string {
  if (!/^0x0{24}[0-9a-f]{40}$/i.test(value)) {
    throw new Error('invalid ABI address result');
  }
  return `0x${value.slice(-40)}`.toLowerCase();
}

export function decodeDecimalsWord(value: string): number {
  if (!/^0x[0-9a-f]{64}$/i.test(value)) {
    throw new Error('invalid ABI decimals result');
  }
  const decoded = BigInt(value);
  if (decoded > BigInt(255)) {
    throw new Error('invalid ABI decimals result');
  }
  return Number(decoded);
}

async function resolveReads<T>(
  network: ChainNetwork,
  reads: LogicalRead<T>[],
  rpc: PoolMetaVerificationRpc,
): Promise<Map<string, ResolvedRead<T>>> {
  const resolved = new Map<string, ResolvedRead<T>>();
  if (reads.length === 0) return resolved;

  let batchResults: Multicall3Result[] | null = null;
  try {
    batchResults = await rpc.multicall(
      network,
      reads.map((read) => ({
        target: read.target,
        allowFailure: true,
        callData: read.callData,
      })),
    );
    if (batchResults.length !== reads.length) {
      throw new Error(`Multicall returned ${batchResults.length} results for ${reads.length} calls`);
    }
  } catch {
    batchResults = null;
  }

  for (const [index, read] of reads.entries()) {
    const batchResult = batchResults?.[index];
    if (batchResult?.success) {
      try {
        resolved.set(read.key, { ok: true, value: read.decode(batchResult.returnData) });
        continue;
      } catch {
        // A malformed successful subcall is not evidence of drift. Retry the
        // same logical read individually before marking it unavailable.
      }
    }

    const attempts = Math.max(1, Math.floor(read.fallbackAttempts ?? 1));
    let lastError = 'RPC subcall failed';
    let succeeded = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const raw = await rpc.ethCall(network, read.target, read.callData);
        resolved.set(read.key, { ok: true, value: read.decode(raw) });
        succeeded = true;
        break;
      } catch (error) {
        lastError = errorMessage(error);
      }
    }
    if (!succeeded) resolved.set(read.key, { ok: false, error: lastError });
  }

  return resolved;
}

function buildMismatches(
  expected: PoolMeta,
  actual: { token0: string; token1: string; decimals0: number; decimals1: number },
): string[] {
  const mismatches: string[] = [];
  if (actual.token0 !== expected.token0.toLowerCase()) {
    mismatches.push(`token0 ${expected.token0} -> ${actual.token0}`);
  }
  if (actual.token1 !== expected.token1.toLowerCase()) {
    mismatches.push(`token1 ${expected.token1} -> ${actual.token1}`);
  }
  if (actual.decimals0 !== expected.decimals0) {
    mismatches.push(`decimals0 ${expected.decimals0} -> ${actual.decimals0}`);
  }
  if (actual.decimals1 !== expected.decimals1) {
    mismatches.push(`decimals1 ${expected.decimals1} -> ${actual.decimals1}`);
  }
  return mismatches;
}

async function verifyNetwork(
  targets: IndexedPool[],
  rpc: PoolMetaVerificationRpc,
  output: Array<PoolMetaVerificationResult | undefined>,
): Promise<void> {
  const network = targets[0].pool.network;
  const addressReads: LogicalRead<string>[] = targets.flatMap((target) => [
    {
      key: `${target.index}:token0`,
      target: target.pool.address,
      callData: TOKEN0_SELECTOR,
      decode: decodeAddressWord,
    },
    {
      key: `${target.index}:token1`,
      target: target.pool.address,
      callData: TOKEN1_SELECTOR,
      decode: decodeAddressWord,
    },
  ]);
  const addresses = await resolveReads(network, addressReads, rpc);

  const discovered = new Map<number, { token0: string; token1: string }>();
  for (const target of targets) {
    const token0 = addresses.get(`${target.index}:token0`);
    const token1 = addresses.get(`${target.index}:token1`);
    if (!token0?.ok || !token1?.ok) {
      const failures = [
        !token0?.ok ? `token0: ${token0?.error || 'missing result'}` : null,
        !token1?.ok ? `token1: ${token1?.error || 'missing result'}` : null,
      ].filter((failure): failure is string => failure !== null);
      output[target.index] = {
        pool: target.pool,
        status: 'unverified',
        mismatches: [],
        error: failures.join('; '),
      };
      continue;
    }
    discovered.set(target.index, { token0: token0.value, token1: token1.value });
  }

  const tokenUseCounts = new Map<string, number>();
  for (const tokens of discovered.values()) {
    tokenUseCounts.set(tokens.token0, (tokenUseCounts.get(tokens.token0) || 0) + 1);
    tokenUseCounts.set(tokens.token1, (tokenUseCounts.get(tokens.token1) || 0) + 1);
  }
  const decimalReads: LogicalRead<number>[] = Array.from(tokenUseCounts.entries()).map(
    ([token, useCount]) => ({
      key: token,
      target: token,
      callData: DECIMALS_SELECTOR,
      decode: decodeDecimalsWord,
      // The old verifier independently retried a shared token once per pool.
      // Preserve those opportunities if the deduplicated batch subcall fails.
      fallbackAttempts: useCount,
    }),
  );
  const decimals = await resolveReads(network, decimalReads, rpc);

  for (const target of targets) {
    const tokens = discovered.get(target.index);
    if (!tokens) continue;
    const decimals0 = decimals.get(tokens.token0);
    const decimals1 = decimals.get(tokens.token1);
    if (!decimals0?.ok || !decimals1?.ok) {
      const failures = [
        !decimals0?.ok ? `decimals0: ${decimals0?.error || 'missing result'}` : null,
        !decimals1?.ok ? `decimals1: ${decimals1?.error || 'missing result'}` : null,
      ].filter((failure): failure is string => failure !== null);
      output[target.index] = {
        pool: target.pool,
        status: 'unverified',
        mismatches: [],
        error: failures.join('; '),
      };
      continue;
    }

    const mismatches = buildMismatches(target.meta, {
      ...tokens,
      decimals0: decimals0.value,
      decimals1: decimals1.value,
    });
    output[target.index] = {
      pool: target.pool,
      status: mismatches.length > 0 ? 'drift' : 'ok',
      mismatches,
    };
  }
}

export async function verifyPoolMetadata(
  pools: PoolConfig[],
  rpc: PoolMetaVerificationRpc,
): Promise<PoolMetaVerificationResult[]> {
  const output: Array<PoolMetaVerificationResult | undefined> = new Array(pools.length);
  const grouped = new Map<ChainNetwork, IndexedPool[]>();

  pools.forEach((pool, index) => {
    if (!pool.meta) {
      output[index] = { pool, status: 'skipped', mismatches: [] };
      return;
    }
    const targets = grouped.get(pool.network) || [];
    targets.push({ index, pool, meta: pool.meta });
    grouped.set(pool.network, targets);
  });

  for (const targets of grouped.values()) {
    await verifyNetwork(targets, rpc, output);
  }

  return output.map((result, index) => {
    if (result) return result;
    return {
      pool: pools[index],
      status: 'unverified',
      mismatches: [],
      error: 'verification produced no result',
    };
  });
}
