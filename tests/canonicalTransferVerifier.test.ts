import { test } from 'node:test';
import assert from 'node:assert/strict';
import canonical from '../scripts/canonical_transfer_verifier.js';

const { createCanonicalTransferVerifier } = canonical;
const A = `0x${'a'.repeat(40)}`, B = `0x${'b'.repeat(40)}`, C = `0x${'c'.repeat(40)}`, TOKEN = `0x${'d'.repeat(40)}`;
const hash = (n: number) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const topic = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`;
const header = (number: number) => ({ blockNumber: number, blockHash: hash(number) });
const log = (number = 11, index = 0, from = A, to = B, amount = 30) => ({
  address: TOKEN, blockNumber: `0x${number.toString(16)}`, blockHash: hash(number), transactionHash: hash(888),
  logIndex: `0x${index.toString(16)}`, removed: false, data: hash(amount),
  topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic(from), topic(to)],
});
const asset = (number = 11, from = A, to = B, amount = 30) => ({
  blockNum: `0x${number.toString(16)}`, hash: hash(888), from, to,
  rawContract: { address: TOKEN, value: `0x${amount.toString(16)}` },
});

test('orphaned log hashes reject even though their shape and fresh headers are valid', async () => {
  const verifier = createCanonicalTransferVerifier({ getBlockHeader: async (n: number) => header(n), getLogsByHash: async () => [] });
  await assert.rejects(verifier.verifyLogs([{ ...log(), blockHash: hash(999) }], TOKEN), { code: 'RPC_CANONICAL_MISMATCH' });
  await verifier.verifyLogs([log()], TOKEN);
});

test('one block-wide log index cannot identify different transactions or amounts', async () => {
  const verifier = createCanonicalTransferVerifier({ getBlockHeader: async (n: number) => header(n), getLogsByHash: async () => [] });
  for (const conflicting of [{ ...log(), transactionHash: hash(999) }, { ...log(), data: hash(31) }]) {
    await assert.rejects(verifier.verifyLogs([log(), conflicting], TOKEN), /share a canonical Transfer log index/);
  }
  await verifier.verifyLogs([log(11, 0, A, A), log(11, 0, A, A)], TOKEN);
  await verifier.verifyLogs([log(11, 0), log(11, 1)], TOKEN);
});

test('indexed orphan events reject against hash-bound canonical logs, including empty results', async () => {
  const calls: unknown[][] = [];
  const verifier = createCanonicalTransferVerifier({
    getBlockHeader: async (n: number) => header(n),
    getLogsByHash: async (...args: unknown[]) => { calls.push(args); return []; },
  });
  await assert.rejects(verifier.verifyAssetTransfers([asset()], TOKEN), /disagree/);
  assert.deepEqual(calls, [[hash(11), TOKEN]]);
});

test('verification checks full event multiplicity in each reported block', async () => {
  const verifier = createCanonicalTransferVerifier({
    getBlockHeader: async (n: number) => header(n), getLogsByHash: async () => [log(11, 0), log(11, 1)],
  });
  await assert.rejects(verifier.verifyAssetTransfers([asset()], TOKEN), /disagree/);
  await verifier.verifyAssetTransfers([asset(), asset()], TOKEN);
  await assert.rejects(verifier.verifyAssetTransfers([asset(), asset(), asset()], TOKEN), /disagree/);
});

test('pool participant filtering counts a self-transfer once and ignores unrelated and zero-value events', async () => {
  const verifier = createCanonicalTransferVerifier({
    getBlockHeader: async (n: number) => header(n),
    getLogsByHash: async () => [log(11, 0, A, A), log(11, 1, B, C, 80), log(11, 2, A, B, 0)],
  });
  await verifier.verifyAssetTransfers([asset(11, A, A)], TOKEN, { participant: A });
  await assert.rejects(verifier.verifyAssetTransfers([asset(11, A, A), asset(11, A, A)], TOKEN, { participant: A }), /disagree/);
});

test('one scan reuses canonical headers and hash-bound log reads across participants', async () => {
  let headers = 0, reads = 0;
  const verifier = createCanonicalTransferVerifier({
    getBlockHeader: async (n: number) => { headers++; return header(n); },
    getLogsByHash: async () => { reads++; return [log()]; },
  });
  await verifier.verifyLogs([log(), log()], TOKEN);
  await verifier.verifyAssetTransfers([asset()], TOKEN, { participant: A });
  await verifier.verifyAssetTransfers([asset()], TOKEN, { participant: B });
  assert.equal(headers, 1); assert.equal(reads, 1);
});

test('a hash-bound RPC cannot silently return logs from another block or contract', async () => {
  for (const response of [[{ ...log(), blockHash: hash(999) }], [{ ...log(), address: A }], [log(), log()]]) {
    const verifier = createCanonicalTransferVerifier({ getBlockHeader: async (n: number) => header(n), getLogsByHash: async () => response });
    await assert.rejects(verifier.verifyAssetTransfers([asset()], TOKEN), { code: 'RPC_CANONICAL_MISMATCH' });
  }
});

test('pinned headers reject conflicting known heights and changed block lookups', async () => {
  assert.throws(() => createCanonicalTransferVerifier({
    getBlockHeader: async (n: number) => header(n), getLogsByHash: async () => [],
    pinnedHeaders: [header(11), { ...header(11), blockHash: hash(999) }],
  }), /Conflicting pinned/);
  const verifier = createCanonicalTransferVerifier({
    getBlockHeader: async (n: number) => ({ ...header(n), blockHash: hash(999) }),
    getLogsByHash: async () => [], pinnedHeaders: [header(11)],
  });
  await assert.rejects(verifier.verifyLogs([log()], TOKEN), /Pinned event block hash changed/);
});

test('failed header or log reads are not cached as successful verification', async () => {
  let headerReads = 0, logReads = 0;
  const verifier = createCanonicalTransferVerifier({
    getBlockHeader: async (n: number) => { if (++headerReads === 1) throw new Error('temporary header failure'); return header(n); },
    getLogsByHash: async () => { if (++logReads === 1) throw new Error('temporary log failure'); return [log()]; },
  });
  await assert.rejects(verifier.verifyAssetTransfers([asset()], TOKEN), /header failure/);
  await assert.rejects(verifier.verifyAssetTransfers([asset()], TOKEN), /log failure/);
  await verifier.verifyAssetTransfers([asset()], TOKEN);
  assert.equal(headerReads, 2); assert.equal(logReads, 2);
});

test('reported-empty ranges make no false claim of independent history completeness', async () => {
  const verifier = createCanonicalTransferVerifier({
    getBlockHeader: async () => { throw new Error('No discovered block'); },
    getLogsByHash: async () => { throw new Error('No discovered block'); },
  });
  await verifier.verifyLogs([], TOKEN);
  await verifier.verifyAssetTransfers([], TOKEN);
});

test('verification observes the cooperative deadline before canonical reads', async () => {
  const verifier = createCanonicalTransferVerifier({
    getBlockHeader: async (n: number) => header(n), getLogsByHash: async () => [log()],
    checkDeadline: () => { throw new Error('budget expired'); },
  });
  await assert.rejects(verifier.verifyLogs([log()], TOKEN), /budget expired/);
  await assert.rejects(verifier.verifyAssetTransfers([asset()], TOKEN), /budget expired/);
});
