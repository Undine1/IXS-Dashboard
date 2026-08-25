import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeVaultTvlReads,
  IXS_VAULT_ASSET_ADDRESS,
  IXS_VAULT_ADDRESS,
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

test('vault TVL uses totalAssets and the contract NAV timestamp', () => {
  const totalAssets = BigInt('3462012121490846858716');
  const timestamp = BigInt(Math.floor(Date.parse('2026-08-25T05:59:48.000Z') / 1000));

  const result = decodeVaultTvlReads([
    ok(uintWord(totalAssets)),
    ok(addressWord(IXS_VAULT_ASSET_ADDRESS)),
    ok(uintWord(BigInt(18))),
    ok(uintWord(timestamp)),
  ]);

  assert.equal(result.name, 'IXS Vault');
  assert.equal(result.address, IXS_VAULT_ADDRESS);
  assert.equal(result.network, 'bsc');
  assert.equal(result.valueUsd, 3462.0121214908468);
  assert.equal(result.navUpdatedAt, '2026-08-25T05:59:48.000Z');
});

test('vault TVL remains valid when its optional NAV timestamp read fails', () => {
  const result = decodeVaultTvlReads([
    ok(uintWord(BigInt(0))),
    ok(addressWord(IXS_VAULT_ASSET_ADDRESS)),
    ok(uintWord(BigInt(18))),
    { success: false, returnData: '0x' },
  ]);

  assert.equal(result.valueUsd, 0);
  assert.equal(result.navUpdatedAt, null);
});

test('vault TVL rejects an unexpected underlying asset or malformed totalAssets', () => {
  const validTail = [
    ok(addressWord(IXS_VAULT_ASSET_ADDRESS)),
    ok(uintWord(BigInt(18))),
    ok(uintWord(BigInt(1))),
  ];

  assert.throws(
    () => decodeVaultTvlReads([ok('0x1234'), ...validTail]),
    /Invalid totalAssets result/,
  );
  assert.throws(
    () => decodeVaultTvlReads([
      ok(uintWord(BigInt(1))),
      ok(addressWord('0x0000000000000000000000000000000000000001')),
      ok(uintWord(BigInt(18))),
      ok(uintWord(BigInt(1))),
    ]),
    /Unexpected vault asset/,
  );
});
