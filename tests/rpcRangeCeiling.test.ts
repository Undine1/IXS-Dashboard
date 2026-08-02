import { test } from 'node:test';
import assert from 'node:assert/strict';
import rangeCeiling from '../scripts/rpc_range_ceiling.js';

const {
  getEthGetLogsRangeSpan,
  inferExplicitProviderRangeCeiling,
  createProviderRangeCeilingTracker,
  chooseRetryRangeCeiling,
} = rangeCeiling;

test('eth_getLogs range spans are derived only from concrete block bounds', () => {
  assert.equal(
    getEthGetLogsRangeSpan('eth_getLogs', [{ fromBlock: '0x64', toBlock: '0x6d' }]),
    10,
  );
  assert.equal(getEthGetLogsRangeSpan('eth_call', [{ fromBlock: '0x64', toBlock: '0x6d' }]), null);
  assert.equal(getEthGetLogsRangeSpan('eth_getLogs', [{ fromBlock: 'latest', toBlock: 'latest' }]), null);
  assert.equal(getEthGetLogsRangeSpan('eth_getLogs', [{ fromBlock: '0x6d', toBlock: '0x64' }]), null);
});

test('provider ceilings are method/chain scoped and only skip oversized ranges', () => {
  const tracker = createProviderRangeCeilingTracker();
  const url = 'https://provider.example/rpc';
  const oversized = [{ fromBlock: '0x64', toBlock: '0xc7' }];
  const compliant = [{ fromBlock: '0x64', toBlock: '0x6d' }];

  assert.equal(tracker.remember('polygon', 'eth_getLogs', url, 20), 20);
  assert.equal(tracker.remember('polygon', 'eth_getLogs', url, 10), 10, 'smaller learned caps win');
  assert.deepEqual(tracker.getSkipDecision('polygon', 'eth_getLogs', url, oversized), {
    ceiling: 10,
    requestedSpan: 100,
  });
  assert.equal(tracker.getSkipDecision('polygon', 'eth_getLogs', url, compliant), null);
  assert.equal(tracker.getSkipDecision('base', 'eth_getLogs', url, oversized), null);
  assert.equal(tracker.getSkipDecision('polygon', 'eth_call', url, oversized), null);
});

test('only explicit provider-wide block caps are cacheable', () => {
  assert.equal(
    inferExplicitProviderRangeCeiling(
      new Error('block range limit exceeded; requests support up to a 50 block range'),
    ),
    50,
  );
  assert.equal(
    inferExplicitProviderRangeCeiling(
      new Error('Based on your parameters, this block range should work: [0x64, 0x6d].'),
    ),
    null,
  );
});

test('retry chooses the largest available provider ceiling', () => {
  assert.equal(chooseRetryRangeCeiling([10, 500, 100]), 500);
  assert.equal(chooseRetryRangeCeiling([null, 0, Number.NaN]), null);
});
