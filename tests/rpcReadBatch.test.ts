import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMulticall3ReadGroups,
  prefetchMulticall3Reads,
} from '../lib/rpcReadBatch';

const TARGET = `0x${'1'.repeat(40)}`;

test('live batches omit failed subcalls so callers can use individual fallback', async () => {
  const grouped = createMulticall3ReadGroups();
  grouped.ethereum.push(
    { key: 'good', target: TARGET, allowFailure: true, callData: '0x01' },
    { key: 'failed', target: TARGET, allowFailure: true, callData: '0x02' },
  );

  const reads = await prefetchMulticall3Reads(grouped, {
    logContext: 'test',
    execute: async () => [
      { success: true, returnData: '0x1234' },
      { success: false, returnData: '0x' },
    ],
  });

  assert.equal(reads.get('good'), '0x1234');
  assert.equal(reads.has('failed'), false);
});

test('snapshot batches retain failed subcalls as null for last-known-good merging', async () => {
  const grouped = createMulticall3ReadGroups();
  grouped.polygon.push({
    key: 'failed',
    target: TARGET,
    allowFailure: true,
    callData: '0x02',
  });

  const reads = await prefetchMulticall3Reads(grouped, {
    logContext: 'test',
    recordFailedSubcalls: true,
    execute: async () => [{ success: false, returnData: '0x' }],
  });

  assert.equal(reads.has('failed'), true);
  assert.equal(reads.get('failed'), null);
});

test('a failed chain batch stays absent and does not prevent later chains', async () => {
  const grouped = createMulticall3ReadGroups();
  grouped.ethereum.push({ key: 'ethereum', target: TARGET, callData: '0x01' });
  grouped.base.push({ key: 'base', target: TARGET, callData: '0x02' });
  const waits: number[] = [];
  const warnings: string[] = [];

  const reads = await prefetchMulticall3Reads(grouped, {
    logContext: 'test',
    execute: async (network) => {
      if (network === 'ethereum') throw new Error('batch unavailable');
      return [{ success: true, returnData: '0xbeef' }];
    },
    wait: async (ms) => {
      waits.push(ms);
    },
    warn: (message) => warnings.push(message),
  });

  assert.equal(reads.has('ethereum'), false);
  assert.equal(reads.get('base'), '0xbeef');
  assert.deepEqual(waits, [100]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ethereum Multicall3 failed; using individual reads/);
});
