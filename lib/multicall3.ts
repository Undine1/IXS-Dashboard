import type { ChainNetwork } from '../types';
import { getRpcUrls, rpcCall } from './rpc';

const AGGREGATE3_SELECTOR = '82ad56cb';
const DEFAULT_MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

export type Multicall3Call = {
  target: string;
  allowFailure?: boolean;
  callData: string;
};

export type Multicall3Result = {
  success: boolean;
  returnData: string;
};

function encodeWord(value: number | bigint): string {
  const bigint = typeof value === 'bigint' ? value : BigInt(value);
  if (bigint < BigInt(0)) throw new Error('Multicall ABI word cannot be negative');
  const encoded = bigint.toString(16);
  if (encoded.length > 64) throw new Error('Multicall ABI word exceeds 32 bytes');
  return encoded.padStart(64, '0');
}

function normalizeBytes(value: string): string {
  const normalized = String(value || '').replace(/^0x/i, '');
  if (!/^[0-9a-f]*$/i.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`Invalid hex bytes: ${value}`);
  }
  return normalized.toLowerCase();
}

function encodeAddress(address: string): string {
  const normalized = normalizeBytes(address);
  if (normalized.length !== 40) throw new Error(`Invalid Multicall target address: ${address}`);
  return normalized.padStart(64, '0');
}

function encodeDynamicBytes(value: string): string {
  const bytes = normalizeBytes(value);
  const paddedLength = Math.ceil(bytes.length / 64) * 64;
  return `${encodeWord(bytes.length / 2)}${bytes.padEnd(paddedLength, '0')}`;
}

function encodeCallTuple(call: Multicall3Call): string {
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
export function encodeAggregate3Call(calls: Multicall3Call[]): string {
  const tuples = calls.map(encodeCallTuple);
  let nextOffsetBytes = calls.length * 32;
  const offsets = tuples.map((tuple) => {
    const offset = encodeWord(nextOffsetBytes);
    nextOffsetBytes += tuple.length / 2;
    return offset;
  });

  return `0x${AGGREGATE3_SELECTOR}${encodeWord(32)}${encodeWord(calls.length)}${offsets.join('')}${tuples.join('')}`;
}

function readWord(data: string, byteOffset: number): bigint {
  const start = byteOffset * 2;
  const word = data.slice(start, start + 64);
  if (word.length !== 64) throw new Error(`Truncated Multicall result at byte ${byteOffset}`);
  return BigInt(`0x${word}`);
}

function toSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Multicall ${label} exceeds the safe integer range`);
  }
  return Number(value);
}

export function decodeAggregate3Result(value: string): Multicall3Result[] {
  const data = normalizeBytes(value);
  const arrayOffset = toSafeNumber(readWord(data, 0), 'array offset');
  const length = toSafeNumber(readWord(data, arrayOffset), 'result length');
  const elementsBase = arrayOffset + 32;
  const results: Multicall3Result[] = [];

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

export async function executeMulticall3(
  network: ChainNetwork,
  calls: Multicall3Call[],
  blockTag = 'latest',
): Promise<Multicall3Result[]> {
  if (calls.length === 0) return [];

  const target = String(process.env.MULTICALL3_ADDRESS || DEFAULT_MULTICALL3_ADDRESS).trim();
  const result = await rpcCall(getRpcUrls(network), {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: target, data: encodeAggregate3Call(calls) }, blockTag],
  });
  const decoded = decodeAggregate3Result(result);
  if (decoded.length !== calls.length) {
    throw new Error(`Multicall returned ${decoded.length} results for ${calls.length} calls`);
  }
  return decoded;
}
