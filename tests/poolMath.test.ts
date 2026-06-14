import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bigintToDecimalNumber, normalizeAddressFromHex, parseHexInt } from '../lib/poolMath';

test('normalizeAddressFromHex extracts and lowercases the trailing 20 bytes', () => {
  const padded = '0x000000000000000000000000ABCDEF0123456789ABCDEF0123456789ABCDEF01';
  assert.equal(normalizeAddressFromHex(padded), '0xabcdef0123456789abcdef0123456789abcdef01');
});

test('parseHexInt decodes a hex decimals value', () => {
  assert.equal(parseHexInt('0x12', 'decimals'), 18);
  assert.equal(parseHexInt('0x06', 'decimals'), 6);
});

test('parseHexInt throws on a non-hex result', () => {
  assert.throws(() => parseHexInt('0xnothex', 'token0 decimals'), /invalid token0 decimals result/);
});

test('bigintToDecimalNumber scales by token decimals', () => {
  // 1.5 tokens at 18 decimals
  assert.equal(bigintToDecimalNumber(BigInt('1500000000000000000'), 18), 1.5);
  // 12.34 USDC at 6 decimals
  assert.equal(bigintToDecimalNumber(BigInt('12340000'), 6), 12.34);
});

test('bigintToDecimalNumber handles zero decimals and negatives', () => {
  assert.equal(bigintToDecimalNumber(BigInt('42'), 0), 42);
  assert.equal(bigintToDecimalNumber(BigInt('-1500000000000000000'), 18), -1.5);
});

test('bigintToDecimalNumber truncates fractional precision rather than rounding', () => {
  // 1 wei at 18 decimals -> truncated to 12 fractional digits -> 0
  assert.equal(bigintToDecimalNumber(BigInt('1'), 18), 0);
});
