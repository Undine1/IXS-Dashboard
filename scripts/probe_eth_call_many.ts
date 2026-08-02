/**
 * Shadow-only compatibility probe for Alchemy eth_callMany.
 *
 * It compares the exact snapshot read plan with the production Multicall3
 * result at one explicit block on each configured chain. The candidate wraps
 * the exact same Multicall3 target and calldata in a single eth_callMany
 * transaction, preserving production ordering and partial-failure semantics.
 * Nothing produced by this script is consumed by the dashboard or its updater.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  compareShadowResults,
  createEthCallManyParams,
  createShadowCallPlan,
  decodeEthCallManyResult,
  ETH_CALL_MANY_POST_SENTINEL_KEY,
  ETH_CALL_MANY_PRE_SENTINEL_KEY,
  ETH_CALL_MANY_TIMEOUT_MS,
  digestShadowResult,
  redactSensitiveText,
  type ShadowComparison,
} from '../lib/ethCallManyShadow';
import multicall3Codec from '../lib/multicall3Codec.js';
import type { TaggedMulticall3Call } from '../lib/rpcReadBatch';
import type { ChainNetwork } from '../types';

const ROOT = path.join(__dirname, '..');
const ARTIFACT_FILE = path.join(ROOT, 'data', 'eth_call_many_shadow.json');
const DEFAULT_MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
// Bump this whenever comparison, shaping, sentinel, or decoding semantics
// change. Evidence streaks may only span identical identity digests.
export const SHADOW_ALGORITHM_VERSION = 1;
const SAMPLE_LAG_BLOCKS = BigInt(5);
const ETH_CALL_MANY_AGGREGATE_KEY = 'shadow:multicall3-envelope';
const NETWORKS: ChainNetwork[] = ['ethereum', 'polygon', 'base'];
const NETWORK_TO_ALCHEMY: Record<ChainNetwork, string> = {
  ethereum: 'eth-mainnet',
  polygon: 'polygon-mainnet',
  base: 'base-mainnet',
};
const CHAIN_IDS: Record<ChainNetwork, bigint> = {
  ethereum: BigInt(1),
  polygon: BigInt(137),
  base: BigInt(8453),
};
const ESTIMATED_ALCHEMY_CU: Record<string, number> = {
  eth_blockNumber: 10,
  eth_getBlockByNumber: 20,
  eth_call: 26,
  eth_callMany: 20,
};

type ProbeStatus = 'pass' | 'mismatch' | 'discarded' | 'unsupported' | 'error';
type ErrorClassification =
  | 'method-unsupported'
  | 'malformed-result'
  | 'baseline-error'
  | 'rpc-error'
  | 'configuration-error';

type ProbeError = {
  classification: ErrorClassification;
  message: string;
};

type BlockEvidence = {
  headAtStart: string;
  number: string;
  lagBlocks: number;
  hashBefore: string;
  hashAfter: string;
  stable: boolean;
};

type UsageEvidence = {
  physicalRequests: number;
  estimatedComputeUnits: number;
  methodCounts: Record<string, number>;
};

type EvidenceIdentity = {
  algorithmVersion: number;
  digest: string;
  readPlanDigest: string;
  multicallAddress: string;
  transactionShapingPolicy: 'none' | 'sampled-block-basefee-and-gas-limit';
  returnDataPolicy: 'strict-0x' | 'polygon-missing-0x-canonicalization';
};

type TransportEvidence = {
  missingHexPrefixCanonicalizations: number;
};

type AggregateEnvelopeEvidence = {
  returnDataParity: boolean;
  baseline: ReturnType<typeof digestShadowResult>;
  candidate: ReturnType<typeof digestShadowResult>;
};

type ChainProbeSample = {
  network: ChainNetwork;
  status: ProbeStatus;
  supported: boolean | null;
  accepted: boolean;
  durationMs: number;
  productionReadCount: number;
  logicalCallCount: number;
  usage: UsageEvidence;
  evidenceIdentity: EvidenceIdentity;
  transport: TransportEvidence;
  aggregateEnvelope?: AggregateEnvelopeEvidence;
  block?: BlockEvidence;
  parity?: ShadowComparison;
  error?: ProbeError;
};

type ProbeArtifact = {
  schemaVersion: 1;
  probe: 'eth_callMany-shadow';
  shadowOnly: true;
  promoted: false;
  gitSha: string;
  startedAt: string;
  completedAt?: string;
  promotionGate: {
    minimumConsecutiveAcceptedSamples: 30;
    minimumObservationDays: 7;
    requiresAllChains: true;
    requiresExactBlockAndResultParity: true;
    requiresFailureCanaryIsolation: true;
    requiresStableEvidenceIdentity: true;
    automaticPromotion: false;
  };
  chains: ChainProbeSample[];
  summary?: {
    acceptedChains: number;
    discardedChains: number;
    failedChains: number;
    allChainsAccepted: boolean;
    physicalRequests: number;
    estimatedComputeUnits: number;
    evidenceSetDigest: string;
  };
  fatalError?: ProbeError;
};

class JsonRpcProbeError extends Error {
  constructor(
    message: string,
    readonly rpcCode: number | null = null,
  ) {
    super(message);
    this.name = 'JsonRpcProbeError';
  }
}

class RpcUsageTracker {
  private readonly methodCounts = new Map<string, number>();

  record(method: string): void {
    this.methodCounts.set(method, (this.methodCounts.get(method) || 0) + 1);
  }

  snapshot(): UsageEvidence {
    const methodCounts = Object.fromEntries(
      [...this.methodCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );
    return {
      physicalRequests: [...this.methodCounts.values()].reduce((sum, count) => sum + count, 0),
      estimatedComputeUnits: [...this.methodCounts.entries()].reduce(
        (sum, [method, count]) => sum + (ESTIMATED_ALCHEMY_CU[method] || 0) * count,
        0,
      ),
      methodCounts,
    };
  }
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function abiUint256Word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

export function createEvidenceIdentity(
  network: ChainNetwork,
  calls: TaggedMulticall3Call[],
  multicallAddress: string,
): EvidenceIdentity {
  const transactionShapingPolicy =
    network === 'polygon' ? 'sampled-block-basefee-and-gas-limit' : 'none';
  const returnDataPolicy =
    network === 'polygon' ? 'polygon-missing-0x-canonicalization' : 'strict-0x';
  const normalizedCalls = calls.map((call) => ({
    key: call.key,
    target: call.target.toLowerCase(),
    callData: call.callData.toLowerCase(),
    allowFailure: call.allowFailure !== false,
  }));
  const readPlanDigest = sha256Json(normalizedCalls);
  const identityPayload = {
    artifactSchemaVersion: 1,
    algorithmVersion: SHADOW_ALGORITHM_VERSION,
    rpcMethod: 'eth_callMany',
    providerNetwork: NETWORK_TO_ALCHEMY[network],
    network,
    chainId: CHAIN_IDS[network].toString(),
    readPlanDigest,
    multicallAddress: multicallAddress.toLowerCase(),
    sampleLagBlocks: SAMPLE_LAG_BLOCKS.toString(),
    simulationContext: { transactionIndex: -1 },
    bundlePolicy: 'one-bundle-one-multicall3-aggregate3-transaction',
    failurePolicy: 'chain-id-sentinel|production-reads|revert-canary|block-number-sentinel',
    sentinelExpectedPolicy: 'chain-id-and-sampled-block-number',
    timeoutMs: ETH_CALL_MANY_TIMEOUT_MS,
    transactionShapingPolicy,
    returnDataPolicy,
  };
  return {
    algorithmVersion: SHADOW_ALGORITHM_VERSION,
    digest: sha256Json(identityPayload),
    readPlanDigest,
    multicallAddress: multicallAddress.toLowerCase(),
    transactionShapingPolicy,
    returnDataPolicy,
  };
}

function loadEnvLocal(): void {
  const envFile = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

function applySnapshotDefaults(): void {
  const defaults: Record<string, string> = {
    NEXT_PUBLIC_ETH_TOKEN_ADDRESS: '0x73d7c860998ca3c01ce8c808f5577d94d545d1b4',
    NEXT_PUBLIC_BASE_TOKEN_ADDRESS: '0xfe550bffb51eb645ea3b324d772a19ac449e92c5',
    NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS: '0x1ba17c639bdaecd8dc4aac37df062d17ee43a1b8',
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!String(process.env[key] || '').trim()) process.env[key] = value;
  }
}

function gitSha(): string {
  const fromEnvironment = String(
    process.env.GITHUB_SHA || process.env.VERCEL_GIT_COMMIT_SHA || '',
  ).trim();
  if (/^[0-9a-f]{40}$/i.test(fromEnvironment)) return fromEnvironment.toLowerCase();
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase();
  } catch {
    return 'unknown';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeBlockNumber(value: unknown): string {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    throw new Error('RPC returned an invalid block number');
  }
  return `0x${BigInt(value).toString(16)}`;
}

function decodeBlock(
  value: unknown,
  expectedNumber: string,
): { number: string; hash: string; baseFeePerGas: string; gasLimit: string } {
  if (!isRecord(value)) throw new Error('RPC returned an invalid block object');
  const number = normalizeBlockNumber(value.number);
  if (number !== expectedNumber) {
    throw new Error(`RPC returned block ${number} while ${expectedNumber} was requested`);
  }
  if (typeof value.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value.hash)) {
    throw new Error('RPC returned an invalid block hash');
  }
  const baseFeePerGas = normalizeBlockNumber(value.baseFeePerGas);
  const gasLimit = normalizeBlockNumber(value.gasLimit);
  if (BigInt(gasLimit) === BigInt(0)) throw new Error('RPC returned a zero block gas limit');
  return { number, hash: value.hash.toLowerCase(), baseFeePerGas, gasLimit };
}

async function rpcRequest(
  rpcUrl: string,
  method: string,
  params: unknown[],
  usage: RpcUsageTracker,
): Promise<unknown> {
  usage.record(method);
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new JsonRpcProbeError(`HTTP ${response.status} ${response.statusText}`);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new JsonRpcProbeError('RPC returned an invalid JSON envelope');
  if (isRecord(payload.error)) {
    const message =
      typeof payload.error.message === 'string' ? payload.error.message : 'JSON-RPC error';
    const code = typeof payload.error.code === 'number' ? payload.error.code : null;
    throw new JsonRpcProbeError(message, code);
  }
  if (!Object.hasOwn(payload, 'result')) {
    throw new JsonRpcProbeError('RPC response is missing result');
  }
  return payload.result;
}

function classifyError(
  error: unknown,
  stage: string,
  sensitiveValues: string[],
): { status: Extract<ProbeStatus, 'unsupported' | 'error'>; error: ProbeError } {
  const message = redactSensitiveText(error, sensitiveValues);
  const unsupported =
    stage === 'candidate-request' &&
    ((error instanceof JsonRpcProbeError && error.rpcCode === -32601) ||
      /method (?:not found|not supported)|unsupported method/i.test(message));
  if (unsupported) {
    return {
      status: 'unsupported',
      error: { classification: 'method-unsupported', message },
    };
  }
  const classification: ErrorClassification =
    stage === 'candidate-decode'
      ? 'malformed-result'
      : stage.startsWith('baseline')
        ? 'baseline-error'
        : 'rpc-error';
  return { status: 'error', error: { classification, message } };
}

async function probeChain(
  network: ChainNetwork,
  productionCalls: TaggedMulticall3Call[],
  rpcUrl: string,
  multicallAddress: string,
  sensitiveValues: string[],
): Promise<ChainProbeSample> {
  const startedAt = Date.now();
  const usage = new RpcUsageTracker();
  const calls = createShadowCallPlan(productionCalls, multicallAddress);
  const evidenceIdentity = createEvidenceIdentity(network, calls, multicallAddress);
  const sample: ChainProbeSample = {
    network,
    status: 'error',
    supported: null,
    accepted: false,
    durationMs: 0,
    productionReadCount: productionCalls.length,
    logicalCallCount: calls.length,
    usage: usage.snapshot(),
    evidenceIdentity,
    transport: { missingHexPrefixCanonicalizations: 0 },
  };
  if (productionCalls.length === 0) {
    sample.error = {
      classification: 'configuration-error',
      message: 'Snapshot read plan contains no production reads for this chain',
    };
    return sample;
  }
  let stage = 'head';

  try {
    const headAtStart = normalizeBlockNumber(
      await rpcRequest(rpcUrl, 'eth_blockNumber', [], usage),
    );
    const headValue = BigInt(headAtStart);
    const head = `0x${(headValue > SAMPLE_LAG_BLOCKS
      ? headValue - SAMPLE_LAG_BLOCKS
      : BigInt(0)
    ).toString(16)}`;
    stage = 'block-before';
    const before = decodeBlock(
      await rpcRequest(rpcUrl, 'eth_getBlockByNumber', [head, false], usage),
      head,
    );
    const shapeTransactions = network === 'polygon';
    const transactionBounds = shapeTransactions
      ? { gasPrice: before.baseFeePerGas, gas: before.gasLimit }
      : {};
    const aggregateCallData = multicall3Codec.encodeAggregate3Call(calls);

    stage = 'baseline-request';
    const baselineRaw = await rpcRequest(
      rpcUrl,
      'eth_call',
      [
        {
          to: multicallAddress,
          data: aggregateCallData,
          ...transactionBounds,
        },
        head,
      ],
      usage,
    );

    stage = 'candidate-request';
    const candidateRaw = await rpcRequest(
      rpcUrl,
      'eth_callMany',
      // Polygon rejects a zero/omitted fee cap and an unbounded implicit gas
      // amount. Supplying the sampled block's own bounds keeps the simulation
      // valid without changing these view-call semantics or adding an RPC.
      // Use the exact Multicall3 target/calldata as one candidate transaction.
      // Multiple eth_callMany bundles advance simulated block headers and are
      // therefore unsuitable for same-block snapshot reads.
      createEthCallManyParams(
        [
          {
            key: ETH_CALL_MANY_AGGREGATE_KEY,
            target: multicallAddress,
            allowFailure: false,
            callData: aggregateCallData,
          },
        ],
        head,
        ETH_CALL_MANY_TIMEOUT_MS,
        shapeTransactions ? before.baseFeePerGas : undefined,
        shapeTransactions ? before.gasLimit : undefined,
      ),
      usage,
    );
    sample.supported = true;

    stage = 'block-after';
    const after = decodeBlock(
      await rpcRequest(rpcUrl, 'eth_getBlockByNumber', [head, false], usage),
      head,
    );
    sample.block = {
      headAtStart,
      number: head,
      lagBlocks: Number(headValue - BigInt(head)),
      hashBefore: before.hash,
      hashAfter: after.hash,
      stable: before.hash === after.hash,
    };
    if (!sample.block.stable) {
      sample.status = 'discarded';
      return sample;
    }

    stage = 'baseline-decode';
    if (typeof baselineRaw !== 'string') {
      throw new Error('Multicall3 baseline returned a non-string result');
    }
    const baseline = multicall3Codec.decodeAggregate3Result(baselineRaw);
    if (baseline.length !== calls.length) {
      throw new Error(`Multicall3 baseline returned ${baseline.length} results for ${calls.length} calls`);
    }

    stage = 'candidate-decode';
    const decodedCandidate = decodeEthCallManyResult(candidateRaw, 1, {
      allowMissingHexPrefix: network === 'polygon',
    });
    sample.transport.missingHexPrefixCanonicalizations =
      decodedCandidate.missingHexPrefixCanonicalizations;
    const candidateEnvelope = decodedCandidate.results[0];
    if (!candidateEnvelope.success) {
      throw new Error('eth_callMany Multicall3 transaction reverted');
    }
    const candidate = multicall3Codec.decodeAggregate3Result(candidateEnvelope.returnData);
    if (candidate.length !== calls.length) {
      throw new Error(`eth_callMany Multicall3 returned ${candidate.length} results for ${calls.length} calls`);
    }
    sample.aggregateEnvelope = {
      returnDataParity: baselineRaw.toLowerCase() === candidateEnvelope.returnData.toLowerCase(),
      baseline: digestShadowResult({ success: true, returnData: baselineRaw }),
      candidate: digestShadowResult(candidateEnvelope),
    };
    stage = 'compare';
    sample.parity = compareShadowResults(calls, baseline, candidate, {
      expectedSuccessReturnData: {
        [ETH_CALL_MANY_PRE_SENTINEL_KEY]: abiUint256Word(CHAIN_IDS[network]),
        [ETH_CALL_MANY_POST_SENTINEL_KEY]: abiUint256Word(BigInt(head)),
      },
    });
    sample.accepted = sample.parity.parity && sample.aggregateEnvelope.returnDataParity;
    sample.status = sample.accepted ? 'pass' : 'mismatch';
    return sample;
  } catch (error) {
    const classified = classifyError(error, stage, sensitiveValues);
    sample.status = classified.status;
    sample.error = classified.error;
    if (classified.status === 'unsupported') sample.supported = false;
    return sample;
  } finally {
    sample.durationMs = Date.now() - startedAt;
    sample.usage = usage.snapshot();
  }
}

function writeArtifact(artifact: ProbeArtifact): void {
  fs.mkdirSync(path.dirname(ARTIFACT_FILE), { recursive: true });
  const temporary = `${ARTIFACT_FILE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.renameSync(temporary, ARTIFACT_FILE);
}

async function main(): Promise<void> {
  loadEnvLocal();
  applySnapshotDefaults();
  const apiKey = String(process.env.ALCHEMY_API_KEY || '').trim();
  const multicallAddress = String(
    process.env.MULTICALL3_ADDRESS || DEFAULT_MULTICALL3_ADDRESS,
  ).trim();
  const artifact: ProbeArtifact = {
    schemaVersion: 1,
    probe: 'eth_callMany-shadow',
    shadowOnly: true,
    promoted: false,
    gitSha: gitSha(),
    startedAt: new Date().toISOString(),
    promotionGate: {
      minimumConsecutiveAcceptedSamples: 30,
      minimumObservationDays: 7,
      requiresAllChains: true,
      requiresExactBlockAndResultParity: true,
      requiresFailureCanaryIsolation: true,
      requiresStableEvidenceIdentity: true,
      automaticPromotion: false,
    },
    chains: [],
  };
  const sensitiveValues = [apiKey];

  try {
    if (!apiKey) throw new Error('ALCHEMY_API_KEY is not set');
    if (!/^0x[0-9a-f]{40}$/i.test(multicallAddress)) {
      throw new Error('MULTICALL3_ADDRESS is invalid');
    }

    // Dynamic import is required: burnStatsService reads its environment at
    // module initialization, after the local env/defaults above are applied.
    const { createSnapshotRpcReadGroups } = await import('../lib/snapshotRpcBatch');
    const grouped = createSnapshotRpcReadGroups();

    for (const [index, network] of NETWORKS.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 100));
      const rpcUrl = `https://${NETWORK_TO_ALCHEMY[network]}.g.alchemy.com/v2/${apiKey}`;
      sensitiveValues.push(rpcUrl);
      const sample = await probeChain(
        network,
        grouped[network],
        rpcUrl,
        multicallAddress,
        sensitiveValues,
      );
      artifact.chains.push(sample);
      console.log(
        `[eth-call-many-shadow] ${network}: ${sample.status} at ${sample.block?.number || 'no-block'} ` +
          `(${sample.productionReadCount} production reads, ${sample.usage.physicalRequests} RPC requests, ` +
          `~${sample.usage.estimatedComputeUnits} CU)`,
      );
    }
  } catch (error) {
    artifact.fatalError = {
      classification: 'configuration-error',
      message: redactSensitiveText(error, sensitiveValues),
    };
  } finally {
    artifact.completedAt = new Date().toISOString();
    const acceptedChains = artifact.chains.filter((sample) => sample.accepted).length;
    const discardedChains = artifact.chains.filter(
      (sample) => sample.status === 'discarded',
    ).length;
    const failedChains = artifact.chains.filter(
      (sample) => !['pass', 'discarded'].includes(sample.status),
    ).length;
    artifact.summary = {
      acceptedChains,
      discardedChains,
      failedChains,
      allChainsAccepted: acceptedChains === NETWORKS.length,
      physicalRequests: artifact.chains.reduce(
        (sum, sample) => sum + sample.usage.physicalRequests,
        0,
      ),
      estimatedComputeUnits: artifact.chains.reduce(
        (sum, sample) => sum + sample.usage.estimatedComputeUnits,
        0,
      ),
      evidenceSetDigest: sha256Json(
        artifact.chains.map((sample) => ({
          network: sample.network,
          digest: sample.evidenceIdentity.digest,
        })),
      ),
    };
    writeArtifact(artifact);
  }

  const hardFailure = Boolean(artifact.fatalError) || Boolean(artifact.summary?.failedChains);
  if (hardFailure) {
    console.error(`[eth-call-many-shadow] probe failed; artifact: ${ARTIFACT_FILE}`);
    process.exitCode = 1;
  } else if (!artifact.summary?.allChainsAccepted) {
    console.warn(`[eth-call-many-shadow] reorg-tainted sample discarded; artifact: ${ARTIFACT_FILE}`);
  } else {
    console.log(`[eth-call-many-shadow] all chains matched; artifact: ${ARTIFACT_FILE}`);
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error('[eth-call-many-shadow] fatal artifact failure:', redactSensitiveText(error));
    process.exitCode = 1;
  });
}
