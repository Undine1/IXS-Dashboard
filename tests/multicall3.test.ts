import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeAggregate3Result,
  encodeAggregate3Call,
} from '../lib/multicall3';

const word = (value: number | bigint) => BigInt(value).toString(16).padStart(64, '0');
const paddedBytes = (hex: string) => hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');

test('aggregate3 calldata encodes a dynamic Call3 array', () => {
  const address = `0x${'a'.repeat(40)}`;
  const callData = '12345678';
  const expected =
    '0x82ad56cb' +
    word(32) +
    word(1) +
    word(32) +
    address.slice(2).padStart(64, '0') +
    word(1) +
    word(96) +
    word(4) +
    paddedBytes(callData);

  assert.equal(
    encodeAggregate3Call([{ target: address, allowFailure: true, callData: `0x${callData}` }]),
    expected,
  );
});

test('aggregate3 result decoding preserves per-call success and return bytes', () => {
  // ABI fixture for [(true, 0x1234), (false, 0x)]. Array element offsets are
  // relative to the element-head region after the array length word.
  const encoded =
    '0x' +
    word(32) +
    word(2) +
    word(64) +
    word(192) +
    word(1) +
    word(64) +
    word(2) +
    paddedBytes('1234') +
    word(0) +
    word(64) +
    word(0);

  assert.deepEqual(decodeAggregate3Result(encoded), [
    { success: true, returnData: '0x1234' },
    { success: false, returnData: '0x' },
  ]);
});

test('aggregate3 decoder rejects truncated return data', () => {
  assert.throws(() => decodeAggregate3Result(`0x${word(32)}`), /Truncated Multicall result/);
});
