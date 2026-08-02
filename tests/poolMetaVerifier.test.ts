import assert from 'node:assert/strict';
import test from 'node:test';
import {
  verifyPoolMetadata,
  type PoolMetaVerificationRpc,
} from '../lib/poolMetaVerifier';
import type { Multicall3Call, Multicall3Result } from '../lib/multicall3';
import type { PoolConfig } from '../lib/poolsConfig';
import type { ChainNetwork } from '../types';

const TOKEN0_SELECTOR = '0x0dfe1681';
const TOKEN1_SELECTOR = '0xd21220a7';
const DECIMALS_SELECTOR = '0x313ce567';

const address = (digit: string) => `0x${digit.repeat(40)}`;
const addressWord = (value: string) => `0x${'0'.repeat(24)}${value.slice(2)}`;
const uintWord = (value: number) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;

function pool(
  name: string,
  pair: string,
  network: ChainNetwork,
  token0: string,
  token1: string,
  decimals0: number,
  decimals1: number,
): PoolConfig {
  return {
    type: 'Test',
    name,
    address: pair,
    network,
    meta: { token0, token1, decimals0, decimals1 },
  };
}

function successfulResult(returnData: string): Multicall3Result {
  return { success: true, returnData };
}

test('pool metadata verifier uses two batches per chain and checks decimals on actual deduplicated tokens', async () => {
  const basePair = address('a');
  const polygonPairA = address('b');
  const polygonPairB = address('c');
  const baseToken0 = address('1');
  const baseToken1 = address('2');
  const sharedPolygonToken = address('3');
  const polygonTokenA = address('4');
  const staleExpectedToken = address('5');
  const actualPolygonToken = address('6');
  const pools: PoolConfig[] = [
    pool('Base', basePair, 'base', baseToken0, baseToken1, 6, 18),
    pool('Polygon A', polygonPairA, 'polygon', sharedPolygonToken, polygonTokenA, 18, 6),
    pool('Polygon B', polygonPairB, 'polygon', sharedPolygonToken, staleExpectedToken, 18, 18),
    { type: 'Test', name: 'Live', address: address('d'), network: 'ethereum' },
  ];
  const pairTokens = new Map([
    [basePair, [baseToken0, baseToken1]],
    [polygonPairA, [sharedPolygonToken, polygonTokenA]],
    [polygonPairB, [sharedPolygonToken, actualPolygonToken]],
  ]);
  const tokenDecimals = new Map([
    [baseToken0, 6],
    [baseToken1, 18],
    [sharedPolygonToken, 18],
    [polygonTokenA, 6],
    [actualPolygonToken, 8],
  ]);
  const batches: Array<{ network: ChainNetwork; calls: Multicall3Call[] }> = [];
  const rpc: PoolMetaVerificationRpc = {
    async multicall(network, calls) {
      batches.push({ network, calls });
      return calls.map((call) => {
        if (call.callData === DECIMALS_SELECTOR) {
          return successfulResult(uintWord(tokenDecimals.get(call.target) ?? 255));
        }
        const tokens = pairTokens.get(call.target);
        assert.ok(tokens);
        return successfulResult(
          addressWord(call.callData === TOKEN0_SELECTOR ? tokens[0] : tokens[1]),
        );
      });
    },
    async ethCall() {
      throw new Error('individual fallback should not run');
    },
  };

  const results = await verifyPoolMetadata(pools, rpc);

  assert.deepEqual(batches.map((batch) => batch.network), ['base', 'base', 'polygon', 'polygon']);
  assert.deepEqual(batches.map((batch) => batch.calls.length), [2, 2, 4, 3]);
  assert.ok(batches.every((batch) => batch.calls.every((call) => call.allowFailure === true)));
  const polygonDecimalTargets = batches[3].calls.map((call) => call.target);
  assert.deepEqual(
    polygonDecimalTargets.sort(),
    [sharedPolygonToken, polygonTokenA, actualPolygonToken].sort(),
  );
  assert.ok(!polygonDecimalTargets.includes(staleExpectedToken));
  assert.deepEqual(results.map((result) => result.status), ['ok', 'ok', 'drift', 'skipped']);
  assert.deepEqual(results[2].mismatches, [
    `token1 ${staleExpectedToken} -> ${actualPolygonToken}`,
    'decimals1 18 -> 8',
  ]);
});

test('failed and malformed batch subcalls retry only those logical reads individually', async () => {
  const pair = address('a');
  const token0 = address('1');
  const token1 = address('2');
  const individualCalls: Array<{ target: string; callData: string }> = [];
  let batch = 0;
  const rpc: PoolMetaVerificationRpc = {
    async multicall() {
      batch += 1;
      if (batch === 1) {
        return [
          { success: false, returnData: '0x' },
          successfulResult(addressWord(token1)),
        ];
      }
      return [
        successfulResult('0x12'),
        successfulResult(uintWord(18)),
      ];
    },
    async ethCall(_network, target, callData) {
      individualCalls.push({ target, callData });
      if (target === pair && callData === TOKEN0_SELECTOR) return addressWord(token0);
      if (target === token0 && callData === DECIMALS_SELECTOR) return uintWord(6);
      throw new Error('unexpected individual read');
    },
  };

  const [result] = await verifyPoolMetadata(
    [pool('Fallback', pair, 'base', token0, token1, 6, 18)],
    rpc,
  );

  assert.equal(result.status, 'ok');
  assert.deepEqual(individualCalls, [
    { target: pair, callData: TOKEN0_SELECTOR },
    { target: token0, callData: DECIMALS_SELECTOR },
  ]);
});

test('a broken aggregate falls back per read and never turns an unavailable pool into drift', async () => {
  const pairA = address('a');
  const pairB = address('b');
  const tokenA0 = address('1');
  const tokenA1 = address('2');
  const tokenB0 = address('3');
  const tokenB1 = address('4');
  let batch = 0;
  const rpc: PoolMetaVerificationRpc = {
    async multicall(_network, calls) {
      batch += 1;
      if (batch === 1) return [];
      return calls.map((call) => successfulResult(uintWord(call.target === tokenB0 ? 18 : 6)));
    },
    async ethCall(_network, target, callData) {
      if (target === pairA && callData === TOKEN0_SELECTOR) throw new Error('temporary outage');
      if (target === pairA && callData === TOKEN1_SELECTOR) return addressWord(tokenA1);
      if (target === pairB && callData === TOKEN0_SELECTOR) return addressWord(tokenB0);
      if (target === pairB && callData === TOKEN1_SELECTOR) return addressWord(tokenB1);
      throw new Error('unexpected individual read');
    },
  };

  const results = await verifyPoolMetadata([
    pool('Unavailable', pairA, 'polygon', tokenA0, tokenA1, 18, 18),
    pool('Healthy', pairB, 'polygon', tokenB0, tokenB1, 18, 6),
  ], rpc);

  assert.equal(results[0].status, 'unverified');
  assert.deepEqual(results[0].mismatches, []);
  assert.match(results[0].error || '', /temporary outage/);
  assert.equal(results[1].status, 'ok');
});

test('a failed shared-token decimal subcall retains every old per-pool retry opportunity', async () => {
  const pairA = address('a');
  const pairB = address('b');
  const sharedToken = address('1');
  const tokenA = address('2');
  const tokenB = address('3');
  let batch = 0;
  let sharedAttempts = 0;
  const rpc: PoolMetaVerificationRpc = {
    async multicall(_network, calls) {
      batch += 1;
      if (batch === 1) {
        return calls.map((call) => {
          const pairTokens = call.target === pairA
            ? [sharedToken, tokenA]
            : [sharedToken, tokenB];
          return successfulResult(
            addressWord(call.callData === TOKEN0_SELECTOR ? pairTokens[0] : pairTokens[1]),
          );
        });
      }
      return calls.map((call) => call.target === sharedToken
        ? { success: false, returnData: '0x' }
        : successfulResult(uintWord(18)));
    },
    async ethCall(_network, target, callData) {
      assert.equal(target, sharedToken);
      assert.equal(callData, DECIMALS_SELECTOR);
      sharedAttempts += 1;
      if (sharedAttempts === 1) throw new Error('first attempt failed');
      return uintWord(18);
    },
  };

  const results = await verifyPoolMetadata([
    pool('Shared A', pairA, 'polygon', sharedToken, tokenA, 18, 18),
    pool('Shared B', pairB, 'polygon', sharedToken, tokenB, 18, 18),
  ], rpc);

  assert.deepEqual(results.map((result) => result.status), ['ok', 'ok']);
  assert.equal(sharedAttempts, 2);
});

test('pools without baked metadata issue no RPC calls', async () => {
  let calls = 0;
  const rpc: PoolMetaVerificationRpc = {
    async multicall() {
      calls += 1;
      return [];
    },
    async ethCall() {
      calls += 1;
      return '0x';
    },
  };

  const [result] = await verifyPoolMetadata(
    [{ type: 'Test', name: 'Live', address: address('a'), network: 'base' }],
    rpc,
  );

  assert.equal(result.status, 'skipped');
  assert.equal(calls, 0);
});
