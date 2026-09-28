// Relative imports keep this service usable from scripts/update_onchain_snapshot.ts.
import type { VaultTvl, VaultTvlResponse } from '../types';
import {
  executeMulticall3WithRpcUrls,
  type Multicall3Call,
  type Multicall3Result,
} from './multicall3';
import { getAvalancheRpcUrls } from './rpc';
import { readSnapshotSection } from './onchainSnapshot';

export const HYB_VAULTS = [
  { name: 'IX High Yield Bond — Permissionless', address: '0xaD01573b459805E3954398796203d830B57A8bD9' },
  { name: 'IX High Yield Bond — Permissioned', address: '0x864E9C192a724773C2bB8C1e84572996074F0B41' },
] as const;
export const HYB_VAULT_ASSET_ADDRESS = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
export const HYB_VAULT_ASSET_DECIMALS = 6;

const TOTAL_ASSETS_SELECTOR = '0x01e1d114';
const ASSET_SELECTOR = '0x38d52e0f';
const DECIMALS_SELECTOR = '0x313ce567';
const PRICE_UPDATED_AT_SELECTOR = '0xb11c4eec';
const CACHE_TTL_MS = 60 * 60 * 1000;

export type VaultTvlServiceResult = {
  payload: VaultTvlResponse;
  healthy: boolean;
  fromCache: boolean;
};

function emptyPayload(): VaultTvlResponse {
  return {
    vaults: HYB_VAULTS.map(({ name, address }) => ({
      name,
      address,
      network: 'avalanche',
      valueUsd: null,
      navUpdatedAt: null,
    })),
    totalValueUsd: null,
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

// Each vault is read once at the same block. BNB routing vault balances are
// excluded; totalAssets already reflects the canonical Avalanche vaults.
export function decodeVaultTvlReads(results: Multicall3Result[]): VaultTvlResponse {
  if (results.length !== HYB_VAULTS.length * 3 + 1) {
    throw new Error('Unexpected vault read count');
  }
  const decimals = decodeUint256(results[results.length - 1], 'asset decimals');
  if (decimals !== BigInt(HYB_VAULT_ASSET_DECIMALS)) {
    throw new Error(`Unexpected vault asset decimals ${decimals.toString()}`);
  }

  const vaults: VaultTvl[] = HYB_VAULTS.map(({ name, address }, index) => {
    const offset = index * 3;
    const totalAssets = decodeUint256(results[offset], `${name} totalAssets`);
    const asset = decodeAddress(results[offset + 1], `${name} asset`);
    if (asset !== HYB_VAULT_ASSET_ADDRESS.toLowerCase()) {
      throw new Error(`Unexpected ${name} asset ${asset}`);
    }
    return {
      name,
      address,
      network: 'avalanche',
      // The dashboard values USDC at $1, consistent with its prior vault rule.
      valueUsd: unitsToNumber(totalAssets, HYB_VAULT_ASSET_DECIMALS),
      navUpdatedAt: decodeOptionalTimestamp(results[offset + 2]),
    };
  });

  return {
    vaults,
    totalValueUsd: vaults.reduce((sum, vault) => sum + (vault.valueUsd ?? 0), 0),
  };
}

export async function computeVaultTvl(): Promise<VaultTvlServiceResult> {
  try {
    // Seven guarded subreads in one physical eth_call, all at the same block.
    const calls: Multicall3Call[] = HYB_VAULTS.flatMap(({ address }) => [
      { target: address, allowFailure: true, callData: TOTAL_ASSETS_SELECTOR },
      { target: address, allowFailure: true, callData: ASSET_SELECTOR },
      { target: address, allowFailure: true, callData: PRICE_UPDATED_AT_SELECTOR },
    ]);
    calls.push({ target: HYB_VAULT_ASSET_ADDRESS, allowFailure: true, callData: DECIMALS_SELECTOR });
    const results = await executeMulticall3WithRpcUrls(getAvalancheRpcUrls(), calls);
    return { payload: decodeVaultTvlReads(results), healthy: true, fromCache: false };
  } catch (error) {
    console.error('[vault TVL service] Unable to read Avalanche HYB vaults:', error);
    return { payload: emptyPayload(), healthy: false, fromCache: false };
  }
}

let cachedPayload: VaultTvlResponse | null = null;
let cachedAtMs = 0;
let vaultTvlInFlight: Promise<VaultTvlServiceResult> | null = null;

export function isHealthyVaultTvlPayload(payload: VaultTvlResponse | null | undefined): payload is VaultTvlResponse {
  if (!payload || !Array.isArray(payload.vaults) || payload.vaults.length !== HYB_VAULTS.length) return false;
  if (typeof payload.totalValueUsd !== 'number' || !Number.isFinite(payload.totalValueUsd) || payload.totalValueUsd < 0) return false;

  let total = 0;
  for (const [index, expected] of HYB_VAULTS.entries()) {
    const vault = payload.vaults[index];
    if (!vault || vault.name !== expected.name || typeof vault.address !== 'string' || vault.address.toLowerCase() !== expected.address.toLowerCase()) return false;
    if (vault.network !== 'avalanche' || typeof vault.valueUsd !== 'number' || !Number.isFinite(vault.valueUsd) || vault.valueUsd < 0) return false;
    total += vault.valueUsd;
  }
  return Math.abs(total - payload.totalValueUsd) < 0.000001;
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
    if (isHealthyVaultTvlPayload(snapshot?.data)) {
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
