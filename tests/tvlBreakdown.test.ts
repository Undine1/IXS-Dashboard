import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTvlBreakdown } from '../lib/tvlBreakdown';
import type { Pool, VaultTvlResponse } from '../types';

const pools: Pool[] = [{
  type: 'Crypto', name: 'IXS/ETH', network: 'ethereum', address: 'combined',
  protocol: 'uniswap-v2+v4', value: 20.49,
  underlyingPools: [
    { address: 'v2', protocol: 'uniswap-v2', value: 10.24 },
    { address: 'v4', protocol: 'uniswap-v4', value: 10.25 },
  ],
}];
const vault: VaultTvlResponse = {
  vaults: [0, 1].map((index) => ({
    name: `Vault ${index}`, address: `vault-${index}`, network: 'avalanche',
    valueUsd: 1.49, navUpdatedAt: null,
  })),
  totalValueUsd: 2.98,
};

test('TVL equals displayed rows without adding underlying pools or the vault aggregate twice', () => {
  const result = getTvlBreakdown(101_830_000, pools, vault);
  assert.equal(result.privateValue, 101_830_000);
  assert.equal(result.pools[0].value, 20);
  assert.deepEqual(result.vaults.map((entry) => entry.valueUsd), [1, 1]);
  assert.equal(result.total, 101_830_022);
  assert.equal(pools[0].value, 20.49, 'raw API valuation remains intact');
  assert.equal(vault.totalValueUsd, 2.98);
});

test('private TVL precision matches its label in millions', () => {
  const result = getTvlBreakdown(101_834_999, pools, vault);
  assert.equal(result.privateValue, 101_830_000);
  assert.equal(result.total, 101_830_022);
});

test('unavailable or invalid visible entries produce N/A instead of a partial total', () => {
  for (const value of [null, NaN, Infinity, -1]) {
    assert.equal(getTvlBreakdown(value, pools, vault).total, null);
    assert.equal(getTvlBreakdown(101_830_000, [{ ...pools[0], value }], vault).total, null);
    assert.equal(getTvlBreakdown(101_830_000, pools, {
      ...vault, vaults: [{ ...vault.vaults[0], valueUsd: value }],
    }).total, null);
  }
  assert.equal(getTvlBreakdown(101_830_000, pools, null).total, null);
  assert.equal(getTvlBreakdown(101_830_000, [], vault).total, null);
  assert.equal(getTvlBreakdown(101_830_000, [{ ...pools[0], value: 0 }], vault).total, 101_830_002);
});
