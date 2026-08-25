// Relative imports keep this service usable from scripts/update_onchain_snapshot.ts.
import type { VaultTvl } from '../types';
import {
  executeMulticall3WithRpcUrls,
  type Multicall3Result,
} from './multicall3';
import { getBscRpcUrls } from './rpc';
import { readSnapshotSection } from './onchainSnapshot';

export const IXS_VAULT_ADDRESS = '0xc975a3EeF2e49F8eDdEf585340C43f15300fCB82';
export const IXS_VAULT_ASSET_ADDRESS = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
export const IXS_VAULT_ASSET_DECIMALS = 18;

const TOTAL_ASSETS_SELECTOR = '0x01e1d114';
const ASSET_SELECTOR = '0x38d52e0f';
const DECIMALS_SELECTOR = '0x313ce567';
const PRICE_UPDATED_AT_SELECTOR = '0xb11c4eec';
const CACHE_TTL_MS = 60 * 60 * 1000;

export type VaultTvlServiceResult = {
  payload: VaultTvl;
  healthy: boolean;
  fromCache: boolean;
};

function emptyPayload(): VaultTvl {
  return {
    name: 'IXS Vault',
    address: IXS_VAULT_ADDRESS,
    network: 'bsc',
    valueUsd: null,
    navUpdatedAt: null,
  };
}

function decodeUint256(result: Multicall3Result | undefined, label: string): bigint {
  if (!result?.success || !/^0x[0-9a-fA-F]{64}$/.test(result.returnData)) {
    throw new Error(`Invalid ${label} result`);
  }
  return BigInt(result.returnData);
}

function decodeAddress(result: Multicall3Result | undefined, label: string): string {
  if (!result?.success || !/^0x[0-9a-fA-F]{64}$/.test(result.returnData)) {
    throw new Error(`Invalid ${label} result`);
  }
  if (!/^0{24}$/i.test(result.returnData.slice(2, 26))) {
    throw new Error(`Invalid ${label} address encoding`);
  }
  return `0x${result.returnData.slice(-40)}`.toLowerCase();
}

function unitsToNumber(value: bigint, decimals: number): number {
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(decimals, '0');
  const parsed = Number(`${whole.toString()}.${fraction}`);
  if (!Number.isFinite(parsed)) throw new Error('Vault totalAssets exceeds numeric range');
  return parsed;
}

function decodeOptionalTimestamp(result: Multicall3Result | undefined): string | null {
  try {
    const timestamp = decodeUint256(result, 'priceUpdatedAt');
    if (timestamp <= BigInt(0) || timestamp > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const date = new Date(Number(timestamp) * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

// Pure correctness boundary for tests. totalAssets is the vault's current
// managed USDC balance; it is not reconstructed from deposits/withdrawals, so
// NAV changes and redemptions cannot create accumulator drift or double counts.
export function decodeVaultTvlReads(results: Multicall3Result[]): VaultTvl {
  const totalAssets = decodeUint256(results[0], 'totalAssets');
  const asset = decodeAddress(results[1], 'asset');
  const decimals = decodeUint256(results[2], 'asset decimals');

  if (asset !== IXS_VAULT_ASSET_ADDRESS.toLowerCase()) {
    throw new Error(`Unexpected vault asset ${asset}`);
  }
  if (decimals !== BigInt(IXS_VAULT_ASSET_DECIMALS)) {
    throw new Error(`Unexpected vault asset decimals ${decimals.toString()}`);
  }

  return {
    name: 'IXS Vault',
    address: IXS_VAULT_ADDRESS,
    network: 'bsc',
    // This mirrors the dashboard's existing stablecoin-at-$1 valuation rule.
    valueUsd: unitsToNumber(totalAssets, IXS_VAULT_ASSET_DECIMALS),
    navUpdatedAt: decodeOptionalTimestamp(results[3]),
  };
}

export async function computeVaultTvl(): Promise<VaultTvlServiceResult> {
  try {
    // Four guarded subreads in one physical eth_call, all from the same block.
    const results = await executeMulticall3WithRpcUrls(getBscRpcUrls(), [
      { target: IXS_VAULT_ADDRESS, allowFailure: true, callData: TOTAL_ASSETS_SELECTOR },
      { target: IXS_VAULT_ADDRESS, allowFailure: true, callData: ASSET_SELECTOR },
      { target: IXS_VAULT_ASSET_ADDRESS, allowFailure: true, callData: DECIMALS_SELECTOR },
      { target: IXS_VAULT_ADDRESS, allowFailure: true, callData: PRICE_UPDATED_AT_SELECTOR },
    ]);
    return { payload: decodeVaultTvlReads(results), healthy: true, fromCache: false };
  } catch (error) {
    console.error('[vault TVL service] Unable to read IXS vault:', error);
    return { payload: emptyPayload(), healthy: false, fromCache: false };
  }
}

let cachedPayload: VaultTvl | null = null;
let cachedAtMs = 0;
let vaultTvlInFlight: Promise<VaultTvlServiceResult> | null = null;

function isHealthyPayload(payload: VaultTvl | null | undefined): payload is VaultTvl {
  return Boolean(
    payload &&
      payload.network === 'bsc' &&
      payload.address.toLowerCase() === IXS_VAULT_ADDRESS.toLowerCase() &&
      typeof payload.valueUsd === 'number' &&
      Number.isFinite(payload.valueUsd) &&
      payload.valueUsd >= 0,
  );
}

function computeVaultTvlSingleFlight(): Promise<VaultTvlServiceResult> {
  if (vaultTvlInFlight) return vaultTvlInFlight;
  const pending = computeVaultTvl().finally(() => {
    if (vaultTvlInFlight === pending) vaultTvlInFlight = null;
  });
  vaultTvlInFlight = pending;
  return pending;
}

export async function getVaultTvl(
  options: { forceFresh?: boolean } = {},
): Promise<VaultTvlServiceResult> {
  if (!options.forceFresh) {
    const snapshot = readSnapshotSection('vaultTvl');
    if (isHealthyPayload(snapshot?.data)) {
      return { payload: snapshot.data, healthy: true, fromCache: true };
    }

    if (cachedPayload && Date.now() - cachedAtMs < CACHE_TTL_MS) {
      return { payload: cachedPayload, healthy: true, fromCache: true };
    }
  }

  const result = await computeVaultTvlSingleFlight();
  if (result.healthy) {
    cachedPayload = result.payload;
    cachedAtMs = Date.now();
  }
  return result;
}
