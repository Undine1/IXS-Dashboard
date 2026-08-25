import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSnapshotSections } from '../scripts/update_onchain_snapshot';

const NOW = '2026-06-12T00:00:00.000Z';
const OLD = '2026-06-11T00:00:00.000Z';

test('mergeSnapshotSections replaces sections that refreshed healthily', () => {
  const previous = {
    pools: { generatedAt: OLD, data: { pools: ['old'] } },
    burnStats: { generatedAt: OLD, data: { ethereum: 'old' } },
    vaultTvl: { generatedAt: OLD, data: { valueUsd: 1 } },
  };

  const next = mergeSnapshotSections(
    previous,
    {
      pools: { data: { pools: ['new'] }, healthy: true },
      burnStats: { data: { ethereum: 'new' }, healthy: true },
      vaultTvl: { data: { valueUsd: 2 }, healthy: true },
    },
    NOW,
  );

  assert.deepEqual(next.pools, { generatedAt: NOW, data: { pools: ['new'] } });
  assert.deepEqual(next.burnStats, { generatedAt: NOW, data: { ethereum: 'new' } });
  assert.deepEqual(next.vaultTvl, { generatedAt: NOW, data: { valueUsd: 2 } });
});

test('mergeSnapshotSections keeps last-known-good data for unhealthy sections', () => {
  const previous = {
    pools: { generatedAt: OLD, data: { pools: ['old'] } },
    burnStats: { generatedAt: OLD, data: { ethereum: 'old' } },
    vaultTvl: { generatedAt: OLD, data: { valueUsd: 1 } },
  };

  const next = mergeSnapshotSections(
    previous,
    {
      pools: { data: { pools: [] }, healthy: false },
      burnStats: { data: { ethereum: 'new' }, healthy: true },
      vaultTvl: { data: { valueUsd: null }, healthy: false },
    },
    NOW,
  );

  assert.deepEqual(next.pools, previous.pools); // stale-but-good beats fresh-but-broken
  assert.deepEqual(next.burnStats, { generatedAt: NOW, data: { ethereum: 'new' } });
  assert.deepEqual(next.vaultTvl, previous.vaultTvl);
});

test('mergeSnapshotSections omits sections with no data at all', () => {
  const next = mergeSnapshotSections(
    null,
    {
      pools: { data: { pools: [] }, healthy: false },
      burnStats: { data: {}, healthy: false },
      vaultTvl: { data: { valueUsd: null }, healthy: false },
    },
    NOW,
  );

  assert.equal(next.pools, undefined);
  assert.equal(next.burnStats, undefined);
  assert.equal(next.vaultTvl, undefined);
});
