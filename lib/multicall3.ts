import type { ChainNetwork } from '../types';
import multicall3Codec from './multicall3Codec.js';
import { getRpcUrls, rpcCall } from './rpc';

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

export function encodeAggregate3Call(calls: Multicall3Call[]): string {
  return multicall3Codec.encodeAggregate3Call(calls);
}

export function decodeAggregate3Result(value: string): Multicall3Result[] {
  return multicall3Codec.decodeAggregate3Result(value);
}

export async function executeMulticall3(
  network: ChainNetwork,
  calls: Multicall3Call[],
  blockTag = 'latest',
): Promise<Multicall3Result[]> {
  return executeMulticall3WithRpcUrls(getRpcUrls(network), calls, blockTag);
}

export async function executeMulticall3WithRpcUrls(
  rpcUrls: string[],
  calls: Multicall3Call[],
  blockTag = 'latest',
): Promise<Multicall3Result[]> {
  if (calls.length === 0) return [];

  const target = String(process.env.MULTICALL3_ADDRESS || DEFAULT_MULTICALL3_ADDRESS).trim();
  const result = await rpcCall(rpcUrls, {
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
