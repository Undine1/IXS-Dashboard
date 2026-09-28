import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeVaultTvlReads,
  HYB_VAULT_ASSET_ADDRESS,
  HYB_VAULTS,
  isHealthyVaultTvlPayload,
} from '../lib/vaultTvlService';
import type { Multicall3Result } from '../lib/multicall3';

function uintWord(value: bigint): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function addressWord(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

function ok(returnData: string): Multicall3Result {
  return { success: true, returnData };
}

function validReads(): Multicall3Result[] {
  return [
    ok(uintWord(BigInt(402_614_429))),
    ok(addressWord(HYB_VAULT_ASSET_ADDRESS)),
    ok(uintWord(BigInt(Math.floor(Date.parse('2026-09-14T06:17:51.000Z') / 1000)))),
    ok(uintWord(BigInt(197_258_337))),
    ok(addressWord(HYB_VAULT_ASSET_ADDRESS)),
    ok(uintWord(BigInt(Math.floor(Date.parse('2026-09-14T06:17:09.000Z') / 1000)))),
    ok(uintWord(BigInt(6))),
  ];
}

test('Avalanche vaults are valued once each with a single USDC decimals read', () => {
  const result = decodeVaultTvlReads(validReads());
  assert.deepEqual(result.vaults.map(({ name, address, network }) => ({ name, address, network })),
    HYB_VAULTS.map(({ name, address }) => ({ name, address, network: 'avalanche' })));
  assert.deepEqual(result.vaults.map((vault) => vault.valueUsd), [402.614429, 197.258337]);
  assert.equal(result.totalValueUsd, 599.872766);
  assert.equal(result.vaults[0].navUpdatedAt, '2026-09-14T06:17:51.000Z');
  assert.ok(isHealthyVaultTvlPayload(result));
});

test('optional NAV timestamp failure does not discard accurate vault values', () => {
  const reads = validReads();
  reads[2] = { success: false, returnData: '0x' };
  const result = decodeVaultTvlReads(reads);
  assert.equal(result.vaults[0].navUpdatedAt, null);
  assert.equal(result.totalValueUsd, 599.872766);
});

test('malformed or mismatched reads fail closed instead of publishing a partial sum', () => {
  const malformed = validReads();
  malformed[3] = ok('0x1234');
  assert.throws(() => decodeVaultTvlReads(malformed), /Invalid .* totalAssets result/);

  const wrongAsset = validReads();
  wrongAsset[4] = ok(addressWord('0x0000000000000000000000000000000000000001'));
  assert.throws(() => decodeVaultTvlReads(wrongAsset), /Unexpected .* asset/);

  const wrongDecimals = validReads();
  wrongDecimals[6] = ok(uintWord(BigInt(18)));
  assert.throws(() => decodeVaultTvlReads(wrongDecimals), /Unexpected vault asset decimals/);
});

test('legacy BNB snapshots and duplicate Avalanche rows cannot enter the aggregate', () => {
  const valid = decodeVaultTvlReads(validReads());
  const legacy = { name: 'IXS Vault', address: '0xc975a3EeF2e49F8eDdEf585340C43f15300fCB82', network: 'bsc', valueUsd: 754 };
  assert.equal(isHealthyVaultTvlPayload(legacy as never), false);
  assert.equal(isHealthyVaultTvlPayload({ ...valid, vaults: [valid.vaults[0], valid.vaults[0]] }), false);
  assert.equal(isHealthyVaultTvlPayload({ ...valid, totalValueUsd: valid.totalValueUsd! * 2 }), false);
});
