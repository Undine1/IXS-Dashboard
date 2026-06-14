// Relative imports (not the @/ alias) so scripts/update_onchain_snapshot.ts
// can run this module under tsx in CI.
import type { ChainNetwork } from '../types';
import { getRpcUrls, rpcCall, sleep } from './rpc';
import { readSnapshotSection } from './onchainSnapshot';

// Core burn-balance logic, shared by /api/burnStats, /metrics, and the CI
// snapshot script. Serving order at request time: hourly committed snapshot
// -> per-instance memory cache -> live RPC fan-out (fallback only).

// Matches the updaters' RPC_MIN_INTERVAL_MS pacing: enough to flatten the
// burst (≤10 req/s) without padding the function's billed wall-time.
const WAIT_BETWEEN_REQUESTS_MS = 100;

export interface BurnStatsApiResponse {
  ethereum: { balances: Record<string, string | null> };
  polygon: { balances: Record<string, string | null> };
  base: { balances: Record<string, string | null> };
}

export type BurnStatsServiceResult = {
  payload: BurnStatsApiResponse;
  // True when at least one balance was fetched and none came back null.
  // Unhealthy results are never cached so an RPC outage cannot get pinned
  // for an hour.
  healthy: boolean;
  fromCache: boolean;
};

// Ethereum Configuration
const ETH_TOKEN_ADDRESS = (process.env.NEXT_PUBLIC_ETH_TOKEN_ADDRESS || '').trim();
const ETH_BURN_ADDRESSES = (process.env.NEXT_PUBLIC_ETH_BURN_ADDRESSES || '')
  .split(',')
  .map((addr: string) => addr.trim())
  .filter((addr: string) => addr.length > 0);

// Polygon Configuration
const POLYGON_TOKEN_ADDRESS = (process.env.NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS || '').trim();
const POLYGON_BURN_ADDRESSES = (process.env.NEXT_PUBLIC_POLYGON_BURN_ADDRESSES || '')
  .split(',')
  .map((addr: string) => addr.trim())
  .filter((addr: string) => addr.length > 0);

// Base Configuration
const BASE_TOKEN_ADDRESS = (process.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS || '').trim();
const BASE_BURN_ADDRESSES = (process.env.NEXT_PUBLIC_BASE_BURN_ADDRESSES || '')
  .split(',')
  .map((addr: string) => addr.trim())
  .filter((addr: string) => addr.length > 0);

function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

async function fetchBalancesForNetwork(
  tokenAddress: string,
  burnAddresses: string[],
  network: ChainNetwork,
): Promise<Record<string, string | null>> {
  const balances: Record<string, string | null> = {};

  if (!isValidAddress(tokenAddress)) {
    console.error(`[burnStats service] Invalid token address for ${network}: ${tokenAddress}`);
    return balances;
  }

  const urls = getRpcUrls(network);
  if (!urls.length) {
    console.error(`[burnStats service] RPC provider is not configured for ${network}`);
    return balances;
  }

  let madePriorCall = false;
  for (const address of burnAddresses) {
    const trimmedAddress = address.trim();

    if (!isValidAddress(trimmedAddress)) {
      console.error(`[burnStats service] Invalid address format for ${network}: ${trimmedAddress}`);
      balances[trimmedAddress] = null;
      continue;
    }

    // Pace between RPC calls only — no trailing sleep after the last address.
    if (madePriorCall) {
      await sleep(WAIT_BETWEEN_REQUESTS_MS);
    }
    madePriorCall = true;

    try {
      const result = await rpcCall(urls, {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          {
            to: tokenAddress,
            data: `0x70a08231000000000000000000000000${trimmedAddress.slice(2)}`,
          },
          'latest',
        ],
      });

      const balance = BigInt(result).toString();
      balances[trimmedAddress] = /^\d+$/.test(balance) ? balance : null;
    } catch (error) {
      console.error(`[burnStats service] Error fetching ${network} balance for ${trimmedAddress}:`, error);
      balances[trimmedAddress] = null;
    }
  }

  return balances;
}

// Best-effort per-instance cache. This is lost on serverless cold starts and is
// NOT a correctness guarantee — the durable layer is the CDN (s-maxage set by
// the routes). Only healthy payloads are stored.
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds
let cachedData: BurnStatsApiResponse | null = null;
let lastFetchTime = 0;

export async function getBurnStatsBody(
  options: { forceFresh?: boolean } = {},
): Promise<BurnStatsServiceResult> {
  const forceFresh = Boolean(options.forceFresh);

  if (!forceFresh) {
    // The hourly pipeline snapshots this data; only sections that fetched
    // healthily are stored, so a stored section can be served as-is.
    const snapshot = readSnapshotSection('burnStats');
    if (snapshot) {
      const balanceCount =
        Object.keys(snapshot.data?.ethereum?.balances || {}).length +
        Object.keys(snapshot.data?.polygon?.balances || {}).length +
        Object.keys(snapshot.data?.base?.balances || {}).length;
      if (balanceCount > 0) {
        return { payload: snapshot.data, healthy: true, fromCache: true };
      }
    }

    if (cachedData && Date.now() - lastFetchTime < CACHE_DURATION) {
      return { payload: cachedData, healthy: true, fromCache: true };
    }
  }

  const result = await computeBurnStats();

  if (result.healthy) {
    cachedData = result.payload;
    lastFetchTime = Date.now();
  }

  return result;
}

// Pure live RPC fan-out, no snapshot/cache involvement. Exported for the CI
// snapshot script.
export async function computeBurnStats(): Promise<BurnStatsServiceResult> {
  const [ethereumBalances, polygonBalances, baseBalances] = [
    ETH_TOKEN_ADDRESS && ETH_BURN_ADDRESSES.length > 0
      ? await fetchBalancesForNetwork(ETH_TOKEN_ADDRESS, ETH_BURN_ADDRESSES, 'ethereum')
      : {},
    POLYGON_TOKEN_ADDRESS && POLYGON_BURN_ADDRESSES.length > 0
      ? await fetchBalancesForNetwork(POLYGON_TOKEN_ADDRESS, POLYGON_BURN_ADDRESSES, 'polygon')
      : {},
    BASE_TOKEN_ADDRESS && BASE_BURN_ADDRESSES.length > 0
      ? await fetchBalancesForNetwork(BASE_TOKEN_ADDRESS, BASE_BURN_ADDRESSES, 'base')
      : {},
  ];

  const payload: BurnStatsApiResponse = {
    ethereum: { balances: ethereumBalances },
    polygon: { balances: polygonBalances },
    base: { balances: baseBalances },
  };

  const allBalances = [
    ...Object.values(ethereumBalances),
    ...Object.values(polygonBalances),
    ...Object.values(baseBalances),
  ];
  const healthy = allBalances.length > 0 && allBalances.every((balance) => balance !== null);

  return { payload, healthy, fromCache: false };
}
