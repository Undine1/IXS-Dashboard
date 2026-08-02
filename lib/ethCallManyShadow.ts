import { createHash } from 'node:crypto';
import type { Multicall3Result } from './multicall3';
import type { TaggedMulticall3Call } from './rpcReadBatch';

export const ETH_CALL_MANY_REVERT_CANARY_KEY = 'shadow:forced-revert';
export const ETH_CALL_MANY_PRE_SENTINEL_KEY = 'shadow:sentinel:chain-id';
export const ETH_CALL_MANY_POST_SENTINEL_KEY = 'shadow:sentinel:block-number';
export const ETH_CALL_MANY_TIMEOUT_MS = 5_000;

const GET_CHAIN_ID_CALL_DATA = '0x3408e470';
const GET_BLOCK_NUMBER_CALL_DATA = '0x42cbb15c';
const REVERTING_AGGREGATE3_CALL_DATA = '0x82ad56cb';

export type EthCallManyBundle = {
  transactions: Array<{ to: string; data: string; gasPrice?: string; gas?: string }>;
};

export type EthCallManyParams = [
  EthCallManyBundle[],
  { blockNumber: string; transactionIndex: -1 },
  Record<string, never>,
  number,
];

export type ShadowResultDigest =
  | { outcome: 'success'; bytes: number; sha256: string }
  | { outcome: 'failure' };

export type ShadowMismatch = {
  key: string;
  reason: 'outcome' | 'return-data' | 'expected-outcome' | 'expected-return-data';
  baseline: ShadowResultDigest;
  candidate: ShadowResultDigest;
};

export type ShadowComparison = {
  parity: boolean;
  canaryIsolated: boolean;
  matchedCalls: number;
  logicalCalls: number;
  baselineSuccesses: number;
  candidateSuccesses: number;
  expectedSuccesses: number;
  verifiedExpectedSuccesses: number;
  mismatches: ShadowMismatch[];
};

export type DecodedEthCallManyResult = {
  results: Multicall3Result[];
  missingHexPrefixCanonicalizations: number;
};

export type ShadowComparisonOptions = {
  canaryKey?: string;
  expectedSuccessReturnData?: Readonly<Record<string, string>>;
};

function normalizeHex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) {
    const shape =
      value === null
        ? 'null'
        : typeof value === 'string'
          ? `string(${value.length} chars)`
          : Array.isArray(value)
            ? `array(${value.length})`
            : typeof value;
    throw new Error(`${label} must be 0x-prefixed, byte-aligned hex; received ${shape}`);
  }
  return value.toLowerCase();
}

function normalizeRpcReturnData(
  value: unknown,
  label: string,
  allowMissingHexPrefix: boolean,
): { returnData: string; canonicalizedMissingPrefix: boolean } {
  if (typeof value !== 'string' || /^0x/i.test(value)) {
    return { returnData: normalizeHex(value, label), canonicalizedMissingPrefix: false };
  }
  if (!allowMissingHexPrefix) {
    return { returnData: normalizeHex(value, label), canonicalizedMissingPrefix: false };
  }
  const bytes = value.replace(/^0x/i, '');
  if (!/^[0-9a-f]*$/i.test(bytes) || bytes.length % 2 !== 0) {
    return { returnData: normalizeHex(value, label), canonicalizedMissingPrefix: false };
  }
  return {
    returnData: `0x${bytes.toLowerCase()}`,
    canonicalizedMissingPrefix: true,
  };
}

function assertUniqueKeys(calls: TaggedMulticall3Call[]): void {
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.key)) {
      throw new Error(`Duplicate shadow read key: ${call.key}`);
    }
    seen.add(call.key);
  }
}

export function createEthCallManyParams(
  calls: TaggedMulticall3Call[],
  blockNumber: string,
  timeoutMs = ETH_CALL_MANY_TIMEOUT_MS,
  gasPrice?: string,
  gas?: string,
): EthCallManyParams {
  assertUniqueKeys(calls);
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(blockNumber)) {
    throw new Error('eth_callMany requires an explicit hexadecimal block number');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('eth_callMany timeout must be a positive integer');
  }
  if (calls.length === 0) {
    throw new Error('eth_callMany requires at least one transaction');
  }
  let normalizedGasPrice: string | undefined;
  if (gasPrice !== undefined) {
    if (!/^0x[0-9a-f]+$/i.test(gasPrice)) {
      throw new Error('eth_callMany gas price must be a hexadecimal quantity');
    }
    normalizedGasPrice = `0x${BigInt(gasPrice).toString(16)}`;
  }
  let normalizedGas: string | undefined;
  if (gas !== undefined) {
    if (!/^0x[0-9a-f]+$/i.test(gas) || BigInt(gas) === BigInt(0)) {
      throw new Error('eth_callMany gas must be a positive hexadecimal quantity');
    }
    normalizedGas = `0x${BigInt(gas).toString(16)}`;
  }

  // eth_callMany advances the simulated header between bundles. Keeping all
  // requested transactions in one ordered bundle is required for same-block
  // semantics. The snapshot probe supplies one transaction: the exact
  // production Multicall3 aggregate call.
  const transactions = calls.map((call, index) => {
    if (!/^0x[0-9a-f]{40}$/i.test(call.target)) {
      throw new Error(`Invalid target for shadow call ${index}`);
    }
    return {
      to: call.target,
      data: normalizeHex(call.callData, `Shadow call ${index} data`),
      ...(normalizedGasPrice === undefined ? {} : { gasPrice: normalizedGasPrice }),
      ...(normalizedGas === undefined ? {} : { gas: normalizedGas }),
    };
  });

  return [
    [{ transactions }],
    { blockNumber: blockNumber.toLowerCase(), transactionIndex: -1 },
    {},
    timeoutMs,
  ];
}

export function createShadowCallPlan(
  productionCalls: TaggedMulticall3Call[],
  multicallAddress: string,
): TaggedMulticall3Call[] {
  const calls: TaggedMulticall3Call[] = [
    {
      key: ETH_CALL_MANY_PRE_SENTINEL_KEY,
      target: multicallAddress,
      allowFailure: false,
      callData: GET_CHAIN_ID_CALL_DATA,
    },
    ...productionCalls,
    {
      key: ETH_CALL_MANY_REVERT_CANARY_KEY,
      target: multicallAddress,
      allowFailure: true,
      callData: REVERTING_AGGREGATE3_CALL_DATA,
    },
    {
      key: ETH_CALL_MANY_POST_SENTINEL_KEY,
      target: multicallAddress,
      allowFailure: false,
      callData: GET_BLOCK_NUMBER_CALL_DATA,
    },
  ];
  assertUniqueKeys(calls);
  return calls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decodeEthCallManyResult(
  value: unknown,
  expectedCount: number,
  options: { allowMissingHexPrefix?: boolean } = {},
): DecodedEthCallManyResult {
  if (!Array.isArray(value)) {
    throw new Error('eth_callMany result must be an array');
  }
  if (value.length !== 1) {
    throw new Error(`eth_callMany returned ${value.length} bundles; expected exactly one`);
  }

  let missingHexPrefixCanonicalizations = 0;
  const bundle = value[0];
  if (!Array.isArray(bundle) || bundle.length !== expectedCount) {
    throw new Error(
      `eth_callMany bundle contains ${Array.isArray(bundle) ? bundle.length : 'non-array'} ` +
        `results for ${expectedCount} transactions`,
    );
  }
  const results = bundle.map((result, bundleIndex) => {
    if (!isRecord(result)) {
      throw new Error(`eth_callMany bundle ${bundleIndex} result must be an object`);
    }

    const hasValue = Object.hasOwn(result, 'value') && result.value !== undefined;
    const hasError =
      Object.hasOwn(result, 'error') && result.error !== undefined && result.error !== null;
    if (hasValue === hasError) {
      throw new Error(
        `eth_callMany bundle ${bundleIndex} must contain exactly one of value or error`,
      );
    }
    if (hasValue) {
      const normalized = normalizeRpcReturnData(
        result.value,
        `eth_callMany bundle ${bundleIndex} value`,
        options.allowMissingHexPrefix === true,
      );
      if (normalized.canonicalizedMissingPrefix) {
        missingHexPrefixCanonicalizations += 1;
      }
      return {
        success: true,
        returnData: normalized.returnData,
      };
    }
    return { success: false, returnData: '0x' };
  });
  return { results, missingHexPrefixCanonicalizations };
}

export function digestShadowResult(result: Multicall3Result): ShadowResultDigest {
  if (!result.success) return { outcome: 'failure' };
  const normalized = normalizeHex(result.returnData, 'Shadow return data');
  const bytes = Buffer.from(normalized.slice(2), 'hex');
  return {
    outcome: 'success',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function compareShadowResults(
  calls: TaggedMulticall3Call[],
  baseline: Multicall3Result[],
  candidate: Multicall3Result[],
  options: ShadowComparisonOptions = {},
): ShadowComparison {
  assertUniqueKeys(calls);
  if (baseline.length !== calls.length) {
    throw new Error(`Baseline returned ${baseline.length} results for ${calls.length} calls`);
  }
  if (candidate.length !== calls.length) {
    throw new Error(`Candidate returned ${candidate.length} results for ${calls.length} calls`);
  }

  const mismatches: ShadowMismatch[] = [];
  let matchedCalls = 0;
  let baselineSuccesses = 0;
  let candidateSuccesses = 0;
  let verifiedExpectedSuccesses = 0;
  const expectedSuccessReturnData = options.expectedSuccessReturnData || {};
  const callKeys = new Set(calls.map((call) => call.key));
  for (const expectedKey of Object.keys(expectedSuccessReturnData)) {
    if (!callKeys.has(expectedKey)) {
      throw new Error(`Expected shadow result has no matching call: ${expectedKey}`);
    }
  }

  calls.forEach((call, index) => {
    const baselineResult = baseline[index];
    const candidateResult = candidate[index];
    if (baselineResult.success) baselineSuccesses += 1;
    if (candidateResult.success) candidateSuccesses += 1;

    const baselineData = baselineResult.success
      ? normalizeHex(baselineResult.returnData, `Baseline result ${index}`)
      : '0x';
    const candidateData = candidateResult.success
      ? normalizeHex(candidateResult.returnData, `Candidate result ${index}`)
      : '0x';
    const expectedValue = expectedSuccessReturnData[call.key];
    const expectedData =
      expectedValue === undefined
        ? undefined
        : normalizeHex(expectedValue, `Expected result for ${call.key}`);
    let reason: ShadowMismatch['reason'] | null = null;
    if (baselineResult.success !== candidateResult.success) {
      reason = 'outcome';
    } else if (baselineResult.success && baselineData !== candidateData) {
      reason = 'return-data';
    } else if (expectedData !== undefined && !baselineResult.success) {
      reason = 'expected-outcome';
    } else if (expectedData !== undefined && baselineData !== expectedData) {
      reason = 'expected-return-data';
    }

    if (
      expectedData !== undefined &&
      baselineResult.success &&
      candidateResult.success &&
      baselineData === expectedData &&
      candidateData === expectedData
    ) {
      verifiedExpectedSuccesses += 1;
    }

    if (reason) {
      mismatches.push({
        key: call.key,
        reason,
        baseline: digestShadowResult(baselineResult),
        candidate: digestShadowResult(candidateResult),
      });
    } else {
      matchedCalls += 1;
    }
  });

  const canaryKey = options.canaryKey || ETH_CALL_MANY_REVERT_CANARY_KEY;
  const canaryIndex = calls.findIndex((call) => call.key === canaryKey);
  if (canaryIndex < 0) {
    throw new Error(`Missing shadow failure canary: ${canaryKey}`);
  }
  const canaryFailed = !baseline[canaryIndex].success && !candidate[canaryIndex].success;
  const nonCanaryMismatch = mismatches.some((mismatch) => mismatch.key !== canaryKey);
  const nonCanaryFailure = calls.some(
    (call, index) =>
      call.key !== canaryKey && (!baseline[index].success || !candidate[index].success),
  );
  const canaryIsolated = canaryFailed && !nonCanaryMismatch && !nonCanaryFailure;

  return {
    parity: mismatches.length === 0 && canaryIsolated,
    canaryIsolated,
    matchedCalls,
    logicalCalls: calls.length,
    baselineSuccesses,
    candidateSuccesses,
    expectedSuccesses: Object.keys(expectedSuccessReturnData).length,
    verifiedExpectedSuccesses,
    mismatches,
  };
}

export function redactSensitiveText(
  value: unknown,
  sensitiveValues: string[] = [],
): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) text = text.split(sensitiveValue).join('[REDACTED]');
  }
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]');
  return text.slice(0, 500);
}
