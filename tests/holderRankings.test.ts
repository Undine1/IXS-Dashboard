import { test } from 'node:test';
import assert from 'node:assert/strict';
import holderRankings from '../scripts/update_holder_rankings.js';

const {
  isValidAddress,
  parseAddressList,
  normalizeTopicAddress,
  getRawBalance,
  applyTransferDelta,
  addThousandsSeparators,
  formatTokenAmount,
  createDefaultState,
  ensureChainState,
  processChainViaAlchemyAssetTransfers,
  processChainViaStandardRpcLogs,
} = holderRankings;

const ZERO = `0x${'0'.repeat(40)}`;
const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const C = `0x${'c'.repeat(40)}`;

// --- helpers for the scan tests (injected fake fetchers, no network/disk) ---
const TOKEN = `0x${'d'.repeat(40)}`;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hex = (v: bigint) => `0x${v.toString(16)}`;
const pad32 = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const xfer = (from: string, to: string, v: bigint): any => ({ from, to, rawContract: { value: hex(v) } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const transferLog = (from: string, to: string, v: bigint): any => ({
  topics: [TRANSFER_TOPIC, pad32(from), pad32(to)],
  data: hex(v),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pager = (pages: any[]) => {
  let i = 0;
  return async () => pages[i++] || { transfers: [], pageKey: null };
};
const noPersist = () => {};
const ethConfig = () => ({ chain: 'ethereum', address: TOKEN, decimals: 18 });

test('isValidAddress accepts 20-byte hex and rejects others', () => {
  assert.equal(isValidAddress(A), true);
  assert.equal(isValidAddress('0x123'), false);
  assert.equal(isValidAddress(''), false);
});

test('parseAddressList lowercases, splits, and drops invalid entries', () => {
  const input = `${A.toUpperCase()}, not-an-address\n${B}`;
  assert.deepEqual(parseAddressList(input), [A, B]);
});

test('normalizeTopicAddress extracts the address from a 32-byte topic', () => {
  const topic = `0x${'0'.repeat(24)}${'a'.repeat(40)}`;
  assert.equal(normalizeTopicAddress(topic), A);
  assert.equal(normalizeTopicAddress('0xshort'), '');
});

test('getRawBalance coerces strings/bigints and defaults to 0n', () => {
  assert.equal(getRawBalance('1000'), 1000n);
  assert.equal(getRawBalance(5n), 5n);
  assert.equal(getRawBalance(''), 0n);
  assert.equal(getRawBalance('not-a-number'), 0n);
});

test('applyTransferDelta tracks running balances across mint and transfers', () => {
  const state = createDefaultState();

  // mint 1000 to A (from zero address is ignored)
  applyTransferDelta(state, 'ethereum', ZERO, A, 1000n);
  assert.equal(state.holders[A].ethereum, '1000');

  // A -> B 400
  applyTransferDelta(state, 'ethereum', A, B, 400n);
  assert.equal(state.holders[A].ethereum, '600');
  assert.equal(state.holders[B].ethereum, '400');

  // A -> B 600 drains A entirely (holder entry removed)
  applyTransferDelta(state, 'ethereum', A, B, 600n);
  assert.equal(state.holders[A], undefined);
  assert.equal(state.holders[B].ethereum, '1000');
});

test('applyTransferDelta clamps (not throws) when a balance would go negative', () => {
  // IXS is not a vanilla ERC-20 (balanceOf is changed by non-Transfer
  // mechanics), so event sums can legitimately go negative for high-volume
  // addresses. Instead of failing the run, the sender is clamped to 0 (and
  // flagged for on-chain balanceOf reconciliation), while the recipient is
  // still credited.
  const state = createDefaultState();
  assert.doesNotThrow(() => applyTransferDelta(state, 'ethereum', C, A, 100n));
  assert.equal(state.holders[C], undefined); // clamped to 0 -> entry removed
  assert.equal(state.holders[A].ethereum, '100'); // recipient still credited
});

test('addThousandsSeparators groups digits', () => {
  assert.equal(addThousandsSeparators('1234567'), '1,234,567');
  assert.equal(addThousandsSeparators('999'), '999');
});

test('formatTokenAmount scales, rounds, and groups', () => {
  assert.equal(formatTokenAmount(`15${'0'.repeat(17)}`, 18), '1.50'); // 1.5
  assert.equal(formatTokenAmount(`12345${'0'.repeat(18)}`, 18), '12,345.00');
  assert.equal(formatTokenAmount(`1234567${'0'.repeat(15)}`, 18), '1,234.57'); // 1234.567 -> 1234.57
});

// --- scan checkpointing / anti-doubling (the pageKey-resume regression) ---

test('alchemy from-scratch scan clears existing balances and drops a stale cursor (no doubling)', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 200); // no lastScannedBlock => full scan
  state.holders[A] = { ethereum: '100' }; // stale/already-counted balance
  // a leftover Alchemy pageKey cursor from an older version: must be ignored+dropped
  chainState.assetTransfersCursor = { fromBlock: 0, toBlock: 200, pageKey: 'stale-uuid' };

  const fetchPage = pager([{ transfers: [xfer(ZERO, A, 50n)], pageKey: null }]);
  await processChainViaAlchemyAssetTransfers(state, chainState, config, 200, 0, { fetchPage, persist: noPersist });

  assert.equal(state.holders[A].ethereum, '50'); // rebuilt from empty, NOT 150 (would be re-stacking)
  assert.equal(chainState.assetTransfersCursor, undefined); // stale cursor dropped
  assert.equal(chainState.lastScannedBlock, 200); // durable block checkpoint set
});

test('alchemy incremental scan preserves balances and applies only the new range', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 200);
  state.holders[A] = { ethereum: '100' };
  chainState.lastScannedBlock = 100; // resume from 101 — must NOT clear

  const fetchPage = pager([{ transfers: [xfer(A, B, 30n)], pageKey: null }]);
  await processChainViaAlchemyAssetTransfers(state, chainState, config, 200, 0, { fetchPage, persist: noPersist });

  assert.equal(state.holders[A].ethereum, '70');
  assert.equal(state.holders[B].ethereum, '30');
  assert.equal(chainState.lastScannedBlock, 200);
});

test('alchemy scan never persists a pageKey cursor (multi-page pagination stays in memory)', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 200);

  const fetchPage = pager([
    { transfers: [xfer(ZERO, A, 100n)], pageKey: 'p1' },
    { transfers: [xfer(A, B, 10n)], pageKey: null },
  ]);
  await processChainViaAlchemyAssetTransfers(state, chainState, config, 200, 0, { fetchPage, persist: noPersist });

  assert.equal(chainState.assetTransfersCursor, undefined);
  assert.equal(state.holders[A].ethereum, '90');
  assert.equal(state.holders[B].ethereum, '10');
});

test('rpc-logs from-scratch scan clears existing balances (no stacking)', async () => {
  const state = createDefaultState();
  const config = ethConfig();
  const chainState = ensureChainState(state, config, 200);
  state.holders[A] = { ethereum: '100' }; // stale balance

  const fetchLogs = async () => [transferLog(ZERO, A, 50n)];
  await processChainViaStandardRpcLogs(state, chainState, config, 200, 0, { fetchLogs, persist: noPersist });

  assert.equal(state.holders[A].ethereum, '50'); // NOT 150
  assert.equal(chainState.lastScannedBlock, 200);
});
