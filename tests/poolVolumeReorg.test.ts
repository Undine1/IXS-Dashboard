import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import poolVolume from '../scripts/update_pool_volume_indexer.js';

const { refreshPoolWithAnchor, setRunDeadline } = poolVolume;
const address = `0x${'a'.repeat(40)}`;
const identity = { chain: 'polygon', poolAddress: address, tokenAddress: address, decimals: 6 };
type Anchor = { lastBlock: number; blockHash: string; totalRaw: string; identity?: typeof identity };
type Checkpoint = { lastBlock: number; lastTimestamp: number; blockHash?: string; finalized?: Anchor };
const header = (number: number, branch = 0) => ({
  number, timestamp: number * 12,
  hash: `0x${(number + branch * 1000000).toString(16).padStart(64, '0')}`,
});

function harness(checkpoint: Checkpoint = { lastBlock: 100, lastTimestamp: 1200 }, total = 1) {
  const poolsMap: Record<string, { total_usd: number; lastUpdated: string; chain: string; usdc: string; usdc_decimals?: number }> = {
    [address]: { total_usd: total, lastUpdated: 'previous', chain: 'polygon', usdc: address, usdc_decimals: 6 },
  };
  const checkpoints: Record<string, Checkpoint> = { [address]: structuredClone(checkpoint) };
  const state = {
    latest: header(103), finalized: header(102),
    config: { chain: 'polygon', pairAddr: address, usdcAddr: address, decimals: 6 },
    failAt: -1, changedBlock: -1, deadlineAt: -1,
    values: new Map([[101, 10n], [102, 20n], [103, 30n], [104, 40n], [105, 50n], [106, 60n]]),
    ranges: [] as Array<[number, number]>, reads: [] as number[], saves: [] as Array<{ total: number; checkpoint: Checkpoint }>,
  };
  const dependencies = {
    getBlock: async (_chain: string, number: number) => {
      state.reads.push(number);
      return state.changedBlock === number ? header(number, 1) : number === state.latest.number ? state.latest : header(number);
    },
    scan: async (start: number, end: number, _pair: string, _token: string, _chain: string, _decimals: number,
      onProgress: (endBlock: number, delta: bigint) => Promise<unknown>) => {
      state.ranges.push([start, end]);
      for (let block = start; block <= end; block += 1) {
        if (block === state.failAt) throw new Error('mock provider unavailable');
        await onProgress(block, state.values.get(block) || 0n);
        if (block === state.deadlineAt) setRunDeadline(0);
      }
      return 'mock';
    },
    persist: () => state.saves.push({ total: poolsMap[address].total_usd, checkpoint: structuredClone(checkpoints[address]) }),
  };
  const run = () => refreshPoolWithAnchor({
    poolsMap, checkpoint: checkpoints, addr: address, legacyCheckpointKey: `${address}-polygon`,
    ...state.config,
    latest: state.latest, finalized: state.finalized,
  }, dependencies);
  return { state, poolsMap, checkpoints, run };
}

afterEach(() => setRunDeadline());

test('legacy migration preserves the baseline and repeated runs replace the tentative tail', async () => {
  const h = harness();
  await h.run();
  assert.equal(h.poolsMap[address].total_usd, 1.00006);
  assert.deepEqual(h.checkpoints[address].finalized, { lastBlock: 102, blockHash: header(102).hash, totalRaw: '1000030', identity });
  assert.deepEqual(h.state.ranges, [[101, 102], [103, 103]]);
  h.state.ranges.length = 0;
  await h.run();
  assert.equal(h.poolsMap[address].total_usd, 1.00006);
  assert.deepEqual(h.state.ranges, [[103, 103]], 'the old finalized range is never recounted');
});

test('a replacement tentative branch corrects the total while keeping latest freshness', async () => {
  const h = harness();
  await h.run();
  h.state.latest = header(103, 2);
  h.state.values.set(103, 90n);
  await h.run();
  assert.equal(h.poolsMap[address].total_usd, 1.00012);
  assert.equal(h.checkpoints[address].lastBlock, 103);
  assert.equal(h.checkpoints[address].blockHash, header(103, 2).hash);
});

test('legacy checkpoints ahead of finality remain untouched until safe migration', async () => {
  const h = harness({ lastBlock: 103, lastTimestamp: 1236 });
  await assert.rejects(h.run, /not finalized yet/);
  assert.equal(h.poolsMap[address].total_usd, 1);
  assert.equal(h.state.saves.length, 0);
  assert.equal(h.state.ranges.length, 0);
});

test('missing checkpoints and mismatched finalized hashes fail closed without scans or writes', async () => {
  const missing = harness();
  delete missing.checkpoints[address];
  await assert.rejects(missing.run, /missing a valid block checkpoint/);
  const mismatch = harness({ lastBlock: 103, lastTimestamp: 1236, finalized: {
    lastBlock: 100, blockHash: header(100, 2).hash, totalRaw: '1000000',
  } });
  await assert.rejects(mismatch.run, /anchor hash mismatch/);
  assert.equal(mismatch.state.ranges.length, 0);
  assert.equal(mismatch.state.saves.length, 0);
});

test('a failed same-head tail replay preserves published data and saves newly finalized work', async () => {
  const h = harness({ lastBlock: 103, lastTimestamp: 1236, finalized: {
    lastBlock: 100, blockHash: header(100).hash, totalRaw: '1000000',
  } }, 1.00006);
  h.state.failAt = 103;
  await assert.rejects(h.run, /mock provider unavailable/);
  assert.equal(h.poolsMap[address].total_usd, 1.00006);
  assert.equal(h.checkpoints[address].lastBlock, 103);
  assert.equal(h.checkpoints[address].lastTimestamp, 1236);
  assert.equal(h.checkpoints[address].finalized?.lastBlock, 102);
  assert.equal(h.checkpoints[address].finalized?.totalRaw, '1000030');
  assert.ok(h.state.saves.every((save) => save.total === 1.00006));
  h.state.failAt = -1;
  h.state.ranges.length = 0;
  await h.run();
  assert.deepEqual(h.state.ranges, [[103, 103]]);
  assert.equal(h.poolsMap[address].total_usd, 1.00006);
});

test('partial finalized progress resumes from its durable anchor without double counting', async () => {
  const h = harness();
  h.state.latest = header(106);
  h.state.finalized = header(105);
  h.state.failAt = 104;
  await assert.rejects(h.run, /mock provider unavailable/);
  assert.equal(h.checkpoints[address].finalized?.lastBlock, 103);
  assert.equal(h.poolsMap[address].total_usd, 1.00006);
  h.state.failAt = -1;
  h.state.ranges.length = 0;
  await h.run();
  assert.deepEqual(h.state.ranges, [[104, 105], [106, 106]]);
  assert.equal(h.poolsMap[address].total_usd, 1.00021);
  assert.equal(h.checkpoints[address].finalized?.totalRaw, '1000150');
});

test('a head hash change during scanning discards the tail and retains finalized progress', async () => {
  const h = harness();
  h.state.changedBlock = 103;
  await assert.rejects(h.run, /Latest block changed/);
  assert.equal(h.poolsMap[address].total_usd, 1.00003);
  assert.equal(h.checkpoints[address].lastBlock, 102);
  assert.equal(h.checkpoints[address].finalized?.totalRaw, '1000030');
});

test('a finalized hash change during an intermediate window refuses every new canonical promotion', async () => {
  const h = harness();
  const previous = structuredClone(h.checkpoints[address]);
  h.state.changedBlock = h.state.finalized.number;
  await assert.rejects(h.run, /Finalized block changed/);
  assert.equal(h.poolsMap[address].total_usd, 1);
  assert.deepEqual(h.checkpoints[address], previous);
  assert.equal(h.state.saves.length, 0);
  assert.deepEqual(h.state.ranges, [[101, 102]], 'failed promotion never rescans already processed windows');
});

test('the finalized endpoint is re-read before promotion when the scan ends exactly there', async () => {
  const h = harness();
  h.state.finalized = header(101);
  h.state.changedBlock = 101;
  await assert.rejects(h.run, /Finalized block changed/);
  assert.equal(h.poolsMap[address].total_usd, 1);
  assert.equal(h.checkpoints[address].finalized, undefined);
  assert.equal(h.state.saves.length, 0);
  assert.ok(h.state.reads.includes(101), 'the cached finalized header cannot authorize promotion');
});

test('a cooperative deadline after scanning the tail never publishes the unverified head', async () => {
  const h = harness();
  h.state.deadlineAt = 103;
  await assert.rejects(h.run, /cooperative run deadline/);
  assert.equal(h.checkpoints[address].lastBlock, 102);
  assert.equal(h.poolsMap[address].total_usd, 1.00003);
});

test('a lagging head preserves a newer published checkpoint', async () => {
  const h = harness({ lastBlock: 104, lastTimestamp: 1248 });
  await assert.rejects(h.run, /head is behind/);
  assert.equal(h.state.saves.length, 0);
  assert.equal(h.checkpoints[address].lastBlock, 104);
});

test('pinned pool identity rejects changed decimals, token, pool and chain before any reads or writes', async () => {
  for (const change of [
    { decimals: 18 }, { usdcAddr: `0x${'b'.repeat(40)}` },
    { pairAddr: `0x${'c'.repeat(40)}` }, { chain: 'base' },
  ]) {
    const h = harness();
    await h.run();
    const previousPool = structuredClone(h.poolsMap[address]);
    const previousCheckpoint = structuredClone(h.checkpoints[address]);
    h.state.config = { ...h.state.config, ...change };
    h.state.ranges.length = 0;
    h.state.reads.length = 0;
    h.state.saves.length = 0;
    await assert.rejects(h.run, /identity or token units changed/);
    assert.deepEqual(h.poolsMap[address], previousPool);
    assert.deepEqual(h.checkpoints[address], previousCheckpoint);
    assert.equal(h.state.ranges.length, 0);
    assert.equal(h.state.reads.length, 0);
    assert.equal(h.state.saves.length, 0);
  }
});

test('untagged finalized anchors verify units against the published total at the same head', async () => {
  const oldAnchor = { lastBlock: 100, blockHash: header(100).hash, totalRaw: '1000000' };
  const h = harness({ lastBlock: 100, lastTimestamp: 1200, finalized: oldAnchor });
  delete h.poolsMap[address].usdc_decimals;
  h.state.latest = header(100);
  h.state.finalized = header(100);
  await h.run();
  assert.equal(h.poolsMap[address].total_usd, 1);
  assert.deepEqual(h.checkpoints[address].finalized, { ...oldAnchor, identity });
  assert.equal(h.state.ranges.length, 0);

  const changed = harness({ lastBlock: 100, lastTimestamp: 1200, finalized: oldAnchor });
  delete changed.poolsMap[address].usdc_decimals;
  changed.state.latest = header(100);
  changed.state.finalized = header(100);
  changed.state.config.decimals = 18;
  await assert.rejects(changed.run, /identity or token units changed/);
  assert.equal(changed.poolsMap[address].total_usd, 1);
  assert.equal(changed.state.saves.length, 0);
});

test('untagged anchors with a tentative tail require known persisted units', async () => {
  const oldCheckpoint = { lastBlock: 103, lastTimestamp: 1236, finalized: {
    lastBlock: 100, blockHash: header(100).hash, totalRaw: '1000000',
  } };
  const h = harness(oldCheckpoint, 1.00006);
  await h.run();
  assert.equal(h.poolsMap[address].total_usd, 1.00006);
  assert.deepEqual(h.checkpoints[address].finalized?.identity, identity);

  const unknown = harness(oldCheckpoint, 1.00006);
  delete unknown.poolsMap[address].usdc_decimals;
  await assert.rejects(unknown.run, /token precision is unknown/);
  assert.equal(unknown.state.saves.length, 0);
  assert.equal(unknown.state.ranges.length, 0);
});

test('existing six-decimal USDC anchors migrate without explicit pool precision', async () => {
  const h = harness({ lastBlock: 103, lastTimestamp: 1236, finalized: {
    lastBlock: 100, blockHash: header(100).hash, totalRaw: '1000000',
  } }, 1.00006);
  const usdc = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
  h.poolsMap[address].usdc = usdc;
  delete h.poolsMap[address].usdc_decimals;
  h.state.config.usdcAddr = usdc;
  await h.run();
  assert.equal(h.poolsMap[address].total_usd, 1.00006);
  assert.deepEqual(h.checkpoints[address].finalized?.identity, { ...identity, tokenAddress: usdc });
});

test('untagged anchors reject address changes against persisted pool metadata', async () => {
  for (const change of [{ usdcAddr: `0x${'b'.repeat(40)}` }, { pairAddr: `0x${'c'.repeat(40)}` }, { chain: 'base' }]) {
    const h = harness({ lastBlock: 103, lastTimestamp: 1236, finalized: {
      lastBlock: 100, blockHash: header(100).hash, totalRaw: '1000000',
    } }, 1.00006);
    h.state.config = { ...h.state.config, ...change };
    await assert.rejects(h.run, /identity or token units changed/);
    assert.equal(h.state.saves.length, 0);
    assert.equal(h.state.ranges.length, 0);
  }
});

test('large finalized raw totals stay exact across multiple promotions', async () => {
  const raw = 9007199254740993000000n;
  const h = harness({ lastBlock: 100, lastTimestamp: 1200, finalized: {
    lastBlock: 100, blockHash: header(100).hash, totalRaw: String(raw), identity,
  } }, Number(raw) / 1e6);
  await h.run();
  assert.equal(h.checkpoints[address].finalized?.totalRaw, String(raw + 30n));
  h.state.latest = header(106);
  h.state.finalized = header(105);
  await h.run();
  assert.equal(h.checkpoints[address].finalized?.totalRaw, String(raw + 150n));
});
