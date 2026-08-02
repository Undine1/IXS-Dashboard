export type Multicall3CodecCall = {
  target: string;
  allowFailure?: boolean;
  callData: string;
};

export type Multicall3CodecResult = {
  success: boolean;
  returnData: string;
};

declare const multicall3Codec: {
  encodeAggregate3Call(calls: Multicall3CodecCall[]): string;
  decodeAggregate3Result(value: string): Multicall3CodecResult[];
};

export default multicall3Codec;
