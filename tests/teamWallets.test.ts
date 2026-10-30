import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterTeamAddresses, ROBINHOOD_IXS_POOL, TEAM_ADDRESSES, TEAM_REVIEW } from '../lib/teamWallets';
import allocations from '../data/team_robinhood_allocations.json';
import roles from '../data/team_robinhood_roles.json';

test('directory has unique valid addresses and keeps the v4 pool ID separate', () => {
  const addresses = TEAM_ADDRESSES.map((entry) => entry.address);
  assert.equal(new Set(addresses).size, addresses.length);
  for (const entry of TEAM_ADDRESSES) {
    assert.match(entry.address, /^0x[0-9a-f]{40}$/);
    assert.ok(entry.sources.length > 0);
    for (const item of entry.sources) {
      const url = new URL(item.url);
      assert.equal(url.protocol, 'https:');
      assert.ok(['robinhoodchain.blockscout.com', 'robinhood.ixs.finance'].includes(url.hostname));
      if (url.pathname.startsWith('/tx/')) assert.match(url.pathname, /^\/tx\/0x[0-9a-f]{64}$/);
    }
    if (entry.relatedAddress) assert.ok(addresses.includes(entry.relatedAddress));
  }
  assert.match(ROBINHOOD_IXS_POOL.id, /^0x[0-9a-f]{64}$/);
  assert.ok(!addresses.includes(ROBINHOOD_IXS_POOL.id));
  for (const address of [ROBINHOOD_IXS_POOL.manager, ROBINHOOD_IXS_POOL.hook, ROBINHOOD_IXS_POOL.module]) assert.ok(addresses.includes(address));
});

test('allocation links preserve observed amounts and do not assert team ownership', () => {
  assert.equal(allocations.length, 30);
  assert.equal(new Set(allocations.map((entry) => entry.address)).size, 30);
  const sums = new Map<string, bigint>();
  for (const allocation of allocations) {
    const entry = TEAM_ADDRESSES.find((item) => item.address === allocation.address);
    assert.ok(entry);
    assert.equal(entry.group, 'allocation');
    assert.equal(entry.evidence, 'transfer');
    assert.equal(entry.relatedAddress, allocation.parent);
    assert.ok(entry.sources.some((item) => item.url.endsWith(allocation.tx)));
    assert.ok(allocation.block <= TEAM_REVIEW.block);
    sums.set(allocation.parent, (sums.get(allocation.parent) ?? BigInt(0)) + BigInt(allocation.amount));
  }
  assert.deepEqual([...sums.values()].map(String).sort(), ['200000000', '200000000', '300000000']);
  for (const entry of TEAM_ADDRESSES.filter((item) => item.group === 'infrastructure')) assert.equal(entry.evidence, 'integration');
  for (const entry of TEAM_ADDRESSES.filter((item) => item.group === 'allocation')) assert.equal(entry.evidence, 'transfer');
});

test('admin and vault roles agree with the saved pinned RPC evidence', () => {
  for (const label of ['token', 'migration', 'vault']) {
    const read = roles.find((item) => item.label === label && item.name === 'owner()');
    assert.ok(read?.result && read.address);
    const owner = `0x${read.result.slice(-40)}`;
    const entry = TEAM_ADDRESSES.find((item) => item.address === owner);
    assert.ok(entry);
    assert.equal(entry.evidence, 'role');
    assert.equal(entry.relatedAddress, read.address);
  }
  const review = roles.find((item) => item.number !== undefined);
  assert.equal(review?.number, TEAM_REVIEW.block);
  assert.equal(Date.parse(review?.asOf ?? ''), Date.parse(TEAM_REVIEW.asOf));
});

test('search handles case, whitespace, roles and category filters', () => {
  const token = TEAM_ADDRESSES.find((entry) => entry.name === 'IXS token')!;
  assert.ok(filterTeamAddresses(`  ${token.address.toUpperCase()}  `, 'all').some((entry) => entry.address === token.address));
  assert.ok(filterTeamAddresses('migration', 'operational').length > 0);
  assert.equal(filterTeamAddresses('migration', 'allocation').length, 0);
  assert.equal(filterTeamAddresses('no-such-wallet', 'all').length, 0);
  assert.equal(filterTeamAddresses('  ', 'all').length, TEAM_ADDRESSES.length);
});
