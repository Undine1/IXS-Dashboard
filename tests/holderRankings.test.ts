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
} = holderRankings;

const ZERO = `0x${'0'.repeat(40)}`;
const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const C = `0x${'c'.repeat(40)}`;

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
