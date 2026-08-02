import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareShadowResults,
  createEthCallManyParams,
  createShadowCallPlan,
  decodeEthCallManyResult,
  ETH_CALL_MANY_POST_SENTINEL_KEY,
  ETH_CALL_MANY_PRE_SENTINEL_KEY,
  ETH_CALL_MANY_REVERT_CANARY_KEY,
  redactSensitiveText,
} from '../lib/ethCallManyShadow';
import type { Multicall3Result } from '../lib/multicall3';
import type { TaggedMulticall3Call } from '../lib/rpcReadBatch';

const TARGET_A = `0x${'1'.repeat(40)}`;
const TARGET_B = `0x${'2'.repeat(40)}`;

function shadowCalls(): TaggedMulticall3Call[] {
  return [
    { key: 'real-read', target: TARGET_A, allowFailure: true, callData: '0xABCD' },
    {
      key: ETH_CALL_MANY_REVERT_CANARY_KEY,
      target: TARGET_B,
      allowFailure: true,
      callData: '0x82ad56cb',
    },
  ];
}

test('eth_callMany request uses one ordered bundle with explicit block and gas bounds', () => {
  assert.deepEqual(createEthCallManyParams(shadowCalls(), '0xABC', 4_000, '0x010', '0x0100'), [
    [
      {
        transactions: [
          { to: TARGET_A, data: '0xabcd', gasPrice: '0x10', gas: '0x100' },
          { to: TARGET_B, data: '0x82ad56cb', gasPrice: '0x10', gas: '0x100' },
        ],
      },
    ],
    { blockNumber: '0xabc', transactionIndex: -1 },
    {},
    4_000,
  ]);
});

test('eth_callMany decoder preserves order and isolates a local revert', () => {
  assert.deepEqual(
    decodeEthCallManyResult(
      [[{ value: 'ABCD' }, { error: { message: 'execution reverted' } }]],
      2,
      { allowMissingHexPrefix: true },
    ),
    {
      results: [
        { success: true, returnData: '0xabcd' },
        { success: false, returnData: '0x' },
      ],
      missingHexPrefixCanonicalizations: 1,
    },
  );
});

test('eth_callMany decoder rejects cardinality and malformed bundle results', () => {
  assert.throws(() => decodeEthCallManyResult([], 1), /expected exactly one/);
  assert.throws(
    () => decodeEthCallManyResult([[{ value: '0x' }, { value: '0x' }]], 1),
    /2 results for 1 transactions/,
  );
  assert.throws(
    () => decodeEthCallManyResult([[{ value: '0x', error: 'revert' }]], 1),
    /exactly one of value or error/,
  );
  assert.throws(
    () => decodeEthCallManyResult([[{ value: '0x123' }]], 1),
    /byte-aligned hex/,
  );
  assert.throws(
    () => decodeEthCallManyResult([[{ value: 'abcd' }]], 1),
    /0x-prefixed/,
  );
});

test('shadow plan brackets the revert with distinct expected-success sentinels', () => {
  const [realRead] = shadowCalls();
  const plan = createShadowCallPlan([realRead], TARGET_B);

  assert.deepEqual(plan.map((call) => call.key), [
    ETH_CALL_MANY_PRE_SENTINEL_KEY,
    'real-read',
    ETH_CALL_MANY_REVERT_CANARY_KEY,
    ETH_CALL_MANY_POST_SENTINEL_KEY,
  ]);
  assert.equal(plan[0].allowFailure, false);
  assert.equal(plan.at(-1)?.allowFailure, false);
  assert.notEqual(plan[0].callData, plan.at(-1)?.callData);
});

test('comparison proves exact result parity and failure-canary isolation', () => {
  const baseline: Multicall3Result[] = [
    { success: true, returnData: '0xabcd' },
    { success: false, returnData: '0x08c379a0' },
  ];
  const candidate: Multicall3Result[] = [
    { success: true, returnData: '0xABCD' },
    { success: false, returnData: '0x' },
  ];

  const comparison = compareShadowResults(shadowCalls(), baseline, candidate);
  assert.equal(comparison.parity, true);
  assert.equal(comparison.canaryIsolated, true);
  assert.equal(comparison.matchedCalls, 2);
  assert.deepEqual(comparison.mismatches, []);
});

test('comparison reports only digests when the canary causes collateral mismatch', () => {
  const baseline: Multicall3Result[] = [
    { success: true, returnData: '0xabcd' },
    { success: false, returnData: '0x' },
  ];
  const candidate: Multicall3Result[] = [
    { success: false, returnData: '0x' },
    { success: false, returnData: '0x' },
  ];

  const comparison = compareShadowResults(shadowCalls(), baseline, candidate);
  assert.equal(comparison.parity, false);
  assert.equal(comparison.canaryIsolated, false);
  assert.equal(comparison.mismatches[0].key, 'real-read');
  assert.equal(comparison.mismatches[0].baseline.outcome, 'success');
  assert.equal(JSON.stringify(comparison).includes('0xabcd'), false);
});

test('matching failures in a production read do not count as canary isolation', () => {
  const bothFailed: Multicall3Result[] = [
    { success: false, returnData: '0x' },
    { success: false, returnData: '0x' },
  ];
  const comparison = compareShadowResults(shadowCalls(), bothFailed, bothFailed);

  assert.equal(comparison.mismatches.length, 0);
  assert.equal(comparison.canaryIsolated, false);
  assert.equal(comparison.parity, false);
});

test('matching but incorrect sentinel bytes fail expected-result verification', () => {
  const baseline: Multicall3Result[] = [
    { success: true, returnData: '0xabcd' },
    { success: false, returnData: '0x' },
  ];
  const comparison = compareShadowResults(shadowCalls(), baseline, baseline, {
    expectedSuccessReturnData: { 'real-read': '0x1234' },
  });

  assert.equal(comparison.parity, false);
  assert.equal(comparison.expectedSuccesses, 1);
  assert.equal(comparison.verifiedExpectedSuccesses, 0);
  assert.equal(comparison.mismatches[0].reason, 'expected-return-data');
});

test('request and comparison reject duplicate read keys', () => {
  const duplicate = [shadowCalls()[0], shadowCalls()[0]];
  assert.throws(() => createEthCallManyParams(duplicate, '0x1'), /Duplicate shadow read key/);
});

test('diagnostics redact provider URLs and API keys', () => {
  const apiKey = 'super-secret-key';
  const rpcUrl = `https://base-mainnet.g.alchemy.com/v2/${apiKey}`;
  const redacted = redactSensitiveText(
    new Error(`request to ${rpcUrl} failed for ${apiKey}`),
    [apiKey, rpcUrl],
  );
  assert.equal(redacted.includes(apiKey), false);
  assert.equal(redacted.includes('https://'), false);
  assert.match(redacted, /REDACTED/);
});
