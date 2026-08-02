import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvidenceIdentity, SHADOW_ALGORITHM_VERSION } from '../scripts/probe_eth_call_many';
import type { TaggedMulticall3Call } from '../lib/rpcReadBatch';

const MULTICALL = `0x${'c'.repeat(40)}`;
const TARGET = `0x${'1'.repeat(40)}`;

function calls(target = TARGET): TaggedMulticall3Call[] {
  return [{ key: 'read', target, allowFailure: true, callData: '0x1234' }];
}

test('evidence identity is deterministic and binds the exact plan and policy', () => {
  const first = createEvidenceIdentity('ethereum', calls(), MULTICALL);
  const repeated = createEvidenceIdentity('ethereum', calls(), MULTICALL);
  const changedTarget = createEvidenceIdentity(
    'ethereum',
    calls(`0x${'2'.repeat(40)}`),
    MULTICALL,
  );
  const polygonPolicy = createEvidenceIdentity('polygon', calls(), MULTICALL);

  assert.deepEqual(first, repeated);
  assert.equal(first.algorithmVersion, SHADOW_ALGORITHM_VERSION);
  assert.notEqual(first.digest, changedTarget.digest);
  assert.notEqual(first.readPlanDigest, changedTarget.readPlanDigest);
  assert.notEqual(first.digest, polygonPolicy.digest);
  assert.equal(first.returnDataPolicy, 'strict-0x');
  assert.equal(polygonPolicy.returnDataPolicy, 'polygon-missing-0x-canonicalization');
  assert.equal(first.transactionShapingPolicy, 'none');
  assert.equal(
    polygonPolicy.transactionShapingPolicy,
    'sampled-block-basefee-and-gas-limit',
  );
});
