import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as holderRankingsRoute from '../app/api/holderRankings/route';
import * as poolVolumeRoute from '../app/api/poolVolume/route';
import * as poolsRoute from '../app/api/pools/route';
import * as burnStatsRoute from '../app/api/burnStats/route';
import * as vaultTvlRoute from '../app/api/vaultTvl/route';
import * as syncStatusRoute from '../app/api/syncStatus/route';
import * as metricsRoute from '../app/metrics/route';

const originalLiveRpcToken = process.env.RPC_LIVE_READ_TOKEN;

afterEach(() => {
  if (originalLiveRpcToken === undefined) delete process.env.RPC_LIVE_READ_TOKEN;
  else process.env.RPC_LIVE_READ_TOKEN = originalLiveRpcToken;
});

test('only deployment-baked API routes are configured for immutable prerendering', () => {
  for (const route of [holderRankingsRoute, poolVolumeRoute, syncStatusRoute]) {
    assert.equal(route.runtime, 'nodejs');
    assert.equal(route.dynamic, 'force-static');
    assert.equal(route.revalidate, false);
  }

  for (const route of [poolsRoute, burnStatsRoute, vaultTvlRoute, metricsRoute]) {
    assert.equal(route.dynamic, 'force-dynamic');
    assert.equal(route.revalidate, 0);
  }
});

test('sync status uses the newest timestamp baked into the deployment', () => {
  const payload = syncStatusRoute.resolveSyncStatusSnapshots(
    { lastRefreshed: '2026-08-26T09:05:53.492Z' },
    { lastUpdated: '2026-08-26T09:05:50.697Z' },
    {
      pools: { generatedAt: '2026-08-26T09:05:57.128Z' },
      burnStats: { generatedAt: '2026-08-26T09:05:57.128Z' },
      vaultTvl: { generatedAt: '2026-08-25T19:53:56.000Z' },
    },
  );

  assert.deepEqual(payload, {
    ok: true,
    lastDeploymentCompletedAt: '2026-08-26T09:05:57.128Z',
    source: 'snapshot',
  });
});

test('sync status reports unavailable when every baked timestamp is invalid', () => {
  const payload = syncStatusRoute.resolveSyncStatusSnapshots(
    { lastRefreshed: 'not-a-date' },
    { lastUpdated: null },
    { pools: { generatedAt: '' } },
  );

  assert.deepEqual(payload, {
    ok: true,
    lastDeploymentCompletedAt: null,
    source: 'unavailable',
  });
});

test('static holder rankings route preserves the baked snapshot contract', async () => {
  const response = await holderRankingsRoute.GET();
  const payload = await response.json();
  const raw = JSON.parse(
    readFileSync(path.join(process.cwd(), 'public', 'data', 'holder_rankings.json'), 'utf8'),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  assert.equal(
    response.headers.get('vercel-cdn-cache-control'),
    'public, max-age=31536000, immutable',
  );
  assert.equal(response.headers.get('cdn-cache-control'), null);
  assert.equal(payload.ok, true);
  assert.equal(payload.rows.length, raw.rows.length);
  assert.equal(payload.totalRowCount, raw.totalRowCount);
  assert.equal(payload.lastRefreshed, raw.lastRefreshed);
});

test('static pool volume route preserves pools and reports the baked timestamp', async () => {
  const response = await poolVolumeRoute.GET();
  const payload = await response.json();
  const raw = JSON.parse(
    readFileSync(path.join(process.cwd(), 'public', 'data', 'pool_volume.json'), 'utf8'),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  assert.equal(
    response.headers.get('vercel-cdn-cache-control'),
    'public, max-age=31536000, immutable',
  );
  assert.equal(response.headers.get('cdn-cache-control'), null);
  assert.deepEqual(Object.keys(payload.data.pools).sort(), Object.keys(raw.pools).sort());
  assert.equal(payload.data.lastUpdated, Date.parse(raw.lastUpdated));
});

test('legacy flat pool snapshots derive a deterministic timestamp from their entries', () => {
  const olderAddress = '0x1111111111111111111111111111111111111111';
  const newerAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const olderTimestamp = '2026-07-01T00:00:00.000Z';
  const newerTimestamp = '2026-07-02T00:00:00.000Z';

  const normalized = poolVolumeRoute.normalizePoolVolume({
    [olderAddress]: { total_usd: 10, lastUpdated: olderTimestamp },
    [newerAddress]: { total_usd: 20, lastUpdated: newerTimestamp },
  });

  assert.deepEqual(
    Object.keys(normalized.pools).sort(),
    [olderAddress.toLowerCase(), newerAddress.toLowerCase()].sort(),
  );
  assert.equal(normalized.lastUpdated, Date.parse(newerTimestamp));
});

test('invalid baked snapshots fail validation instead of becoming static 200/500 responses', () => {
  assert.throws(
    () => holderRankingsRoute.normalizeHolderRankingsSnapshot({ ok: true, rows: [{}] }),
    /invalid row/,
  );
  assert.throws(
    () => holderRankingsRoute.normalizeHolderRankingsSnapshot({ ok: false, rows: [] }),
    /successful rows array/,
  );
  assert.throws(
    () => poolVolumeRoute.normalizePoolVolume({ pools: [], lastUpdated: Date.now() }),
    /pools must be an object/,
  );
  assert.throws(
    () => poolVolumeRoute.normalizePoolVolume({ pools: {}, lastUpdated: 'not-a-date' }),
    /invalid lastUpdated timestamp/,
  );
});

test('fresh and debug requests remain token-gated and uncacheable', async () => {
  process.env.RPC_LIVE_READ_TOKEN = 'route-cache-test-token';

  const responses = await Promise.all([
    poolsRoute.GET(new Request('https://example.test/api/pools?fresh=1')),
    poolsRoute.GET(new Request('https://example.test/api/pools?debug=1')),
    burnStatsRoute.GET(new Request('https://example.test/api/burnStats?fresh=1')),
    vaultTvlRoute.GET(new Request('https://example.test/api/vaultTvl?fresh=1')),
  ]);

  for (const response of responses) {
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});
