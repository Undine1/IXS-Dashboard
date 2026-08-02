const AGGREGATE3_SELECTOR = '82ad56cb';

function encodeWord(value) {
  const bigint = typeof value === 'bigint' ? value : BigInt(value);
  if (bigint < BigInt(0)) throw new Error('Multicall ABI word cannot be negative');
  const encoded = bigint.toString(16);
  if (encoded.length > 64) throw new Error('Multicall ABI word exceeds 32 bytes');
  return encoded.padStart(64, '0');
}

function normalizeBytes(value) {
  const normalized = String(value || '').replace(/^0x/i, '');
  if (!/^[0-9a-f]*$/i.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`Invalid hex bytes: ${value}`);
  }
  return normalized.toLowerCase();
}

function encodeAddress(address) {
  const normalized = normalizeBytes(address);
  if (normalized.length !== 40) throw new Error(`Invalid Multicall target address: ${address}`);
  return normalized.padStart(64, '0');
}

function encodeDynamicBytes(value) {
  const bytes = normalizeBytes(value);
  const paddedLength = Math.ceil(bytes.length / 64) * 64;
  return `${encodeWord(bytes.length / 2)}${bytes.padEnd(paddedLength, '0')}`;
}

function encodeCallTuple(call) {
  const dynamicBytes = encodeDynamicBytes(call.callData);
  return (
    encodeAddress(call.target) +
    encodeWord(call.allowFailure === false ? 0 : 1) +
    encodeWord(96) +
    dynamicBytes
  );
}

// aggregate3((address,bool,bytes)[]) uses an array of dynamic tuples. Offsets
// inside a dynamic array are relative to the element-head region immediately
// after the array length word.
function encodeAggregate3Call(calls) {
  const tuples = calls.map(encodeCallTuple);
  let nextOffsetBytes = calls.length * 32;
  const offsets = tuples.map((tuple) => {
    const offset = encodeWord(nextOffsetBytes);
    nextOffsetBytes += tuple.length / 2;
    return offset;
  });

  return `0x${AGGREGATE3_SELECTOR}${encodeWord(32)}${encodeWord(calls.length)}${offsets.join('')}${tuples.join('')}`;
}

function readWord(data, byteOffset) {
  const start = byteOffset * 2;
  const word = data.slice(start, start + 64);
  if (word.length !== 64) throw new Error(`Truncated Multicall result at byte ${byteOffset}`);
  return BigInt(`0x${word}`);
}

function toSafeNumber(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Multicall ${label} exceeds the safe integer range`);
  }
  return Number(value);
}

function decodeAggregate3Result(value) {
  const data = normalizeBytes(value);
  const arrayOffset = toSafeNumber(readWord(data, 0), 'array offset');
  const length = toSafeNumber(readWord(data, arrayOffset), 'result length');
  const elementsBase = arrayOffset + 32;
  const results = [];

  for (let index = 0; index < length; index += 1) {
    const tupleOffset = toSafeNumber(
      readWord(data, elementsBase + index * 32),
      `tuple ${index} offset`,
    );
    const tupleStart = elementsBase + tupleOffset;
    const success = readWord(data, tupleStart) !== BigInt(0);
    const bytesOffset = toSafeNumber(
      readWord(data, tupleStart + 32),
      `tuple ${index} bytes offset`,
    );
    const bytesStart = tupleStart + bytesOffset;
    const byteLength = toSafeNumber(
      readWord(data, bytesStart),
      `tuple ${index} byte length`,
    );
    const payloadStart = (bytesStart + 32) * 2;
    const payload = data.slice(payloadStart, payloadStart + byteLength * 2);
    if (payload.length !== byteLength * 2) {
      throw new Error(`Truncated Multicall return data for tuple ${index}`);
    }
    results.push({ success, returnData: `0x${payload}` });
  }

  return results;
}

module.exports = { encodeAggregate3Call, decodeAggregate3Result };
