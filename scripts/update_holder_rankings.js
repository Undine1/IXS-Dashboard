const fs = require('fs');
const path = require('path');
const {
  createProviderRangeCeilingTracker,
  chooseRetryRangeCeiling,
  inferExplicitProviderRangeCeiling,
} = require('./rpc_range_ceiling');
const {
  createRpcRunUsageTracker,
  getRpcUsageRunId,
  writeRpcUsageComponent,
} = require('./rpc_run_usage');
const {
  encodeAggregate3Call,
  decodeAggregate3Result,
} = require('../lib/multicall3Codec');
const {
  readRpcResponse,
  sanitizeRpcMessage,
  createProviderCooldowns,
} = require('./rpc_transport');

function loadEnvLocal() {
  try {
    const envFile = path.join(__dirname, '..', '.env.local');
    if (!fs.existsSync(envFile)) return;

    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;

      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    console.warn('[holder-rankings] Unable to load .env.local:', error && error.message);
  }
}

if (require.main === module) loadEnvLocal();

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEFAULT_TOKEN_DECIMALS = 18;
// The public snapshot keeps 600 rows even though the UI shows a top 500. The
// extra 100 are deliberate leeway: when the user hides named holders
// (contracts/bridges/exchanges), those are filtered out client-side, and the
// surplus lets the list still fill to a full 500 unnamed holders. Keep this
// comfortably above HOLDER_DISPLAY_LIMIT in components/BurnStats.tsx.
const DEFAULT_LIMIT = 600;
const DEFAULT_LOG_CHUNK = 20000;
const DEFAULT_MIN_LOG_CHUNK = 500;
const DEFAULT_SAVE_EVERY_BATCHES = 10;
const DEFAULT_MAX_FALLBACK_LOG_WINDOWS = 2000;
const DEFAULT_RECONCILE_BATCH_SIZE = 100;
const DEFAULT_MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const HOLDER_STATE_VERSION = 2;
const HOLDER_STATE_PERSIST_FAILED = 'HOLDER_STATE_PERSIST_FAILED';

const ALCHEMY_API_KEY = String(process.env.ALCHEMY_API_KEY || '').trim();
const BACKUP_INFURA_API_KEY = String(process.env.BACKUP_INFURA_API_KEY || '').trim();
const BACKUP_CHAINSTACK_BASE_RPC_URL = String(process.env.BACKUP_CHAINSTACK_BASE_RPC_URL || '').trim();
const ALCHEMY_NETWORKS = {
  ethereum: 'eth-mainnet',
  polygon: 'polygon-mainnet',
  base: 'base-mainnet',
};
const INFURA_NETWORKS = {
  ethereum: 'mainnet',
  polygon: 'polygon-mainnet',
  base: 'base-mainnet',
};

const TOKEN_CONFIGS = [
  {
    chain: 'ethereum',
    address: (
      process.env.HOLDER_RANKINGS_ETHEREUM_TOKEN_ADDRESS ||
      process.env.NEXT_PUBLIC_ETH_TOKEN_ADDRESS ||
      '0x73d7c860998ca3c01ce8c808f5577d94d545d1b4'
    ).toLowerCase(),
    decimals: Number(process.env.HOLDER_RANKINGS_ETHEREUM_DECIMALS || DEFAULT_TOKEN_DECIMALS),
    startBlockEnv: 'HOLDER_RANKINGS_ETHEREUM_START_BLOCK',
  },
  {
    chain: 'base',
    address: (
      process.env.HOLDER_RANKINGS_BASE_TOKEN_ADDRESS ||
      process.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS ||
      '0xfe550bffb51eb645ea3b324d772a19ac449e92c5'
    ).toLowerCase(),
    decimals: Number(process.env.HOLDER_RANKINGS_BASE_DECIMALS || DEFAULT_TOKEN_DECIMALS),
    startBlockEnv: 'HOLDER_RANKINGS_BASE_START_BLOCK',
  },
  {
    chain: 'polygon',
    address: (
      process.env.HOLDER_RANKINGS_POLYGON_TOKEN_ADDRESS ||
      process.env.NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS ||
      '0x1ba17c639bdaecd8dc4aac37df062d17ee43a1b8'
    ).toLowerCase(),
    decimals: Number(process.env.HOLDER_RANKINGS_POLYGON_DECIMALS || DEFAULT_TOKEN_DECIMALS),
    startBlockEnv: 'HOLDER_RANKINGS_POLYGON_START_BLOCK',
  },
];

const EXCLUSION_ENV_KEYS = [
  'HOLDER_RANKINGS_EXCLUDED_ADDRESSES',
  'HOLDER_RANKINGS_ETHEREUM_EXCLUDED_ADDRESSES',
  'HOLDER_RANKINGS_BASE_EXCLUDED_ADDRESSES',
  'HOLDER_RANKINGS_POLYGON_EXCLUDED_ADDRESSES',
  'NEXT_PUBLIC_ETH_BURN_ADDRESSES',
  'NEXT_PUBLIC_BASE_BURN_ADDRESSES',
  'NEXT_PUBLIC_POLYGON_BURN_ADDRESSES',
];

const STATE_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'data');
// Overridable so tests can point persistence at a temp file instead of the
// real data dir.
const STATE_FILE = process.env.HOLDER_RANKINGS_STATE_FILE || path.join(STATE_DIR, 'holder_rankings_state.json');
const LABELS_FILE = path.join(STATE_DIR, 'holder_labels.json');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'holder_rankings.json');
const RPC_USAGE_FILE = path.join(STATE_DIR, 'rpc_usage.json');

let rpcCallCount = 0;
let retryCount = 0;
const disabledProviders = new Map();
const providerRangeCeilings = createProviderRangeCeilingTracker();
const rpcRunUsage = createRpcRunUsageTracker();
const providerCooldowns = createProviderCooldowns();
let activeRunDeadline = null;

function holderError(code, message) {
  return Object.assign(new Error(sanitizeRpcMessage(message)), { code });
}

function createHolderRunDeadline(value = process.env.RPC_RUN_BUDGET_MS, now = Date.now) {
  const parsed = Number(value || 32 * 60 * 1000);
  const deadline = now() + (Number.isFinite(parsed) && parsed > 0 ? parsed : 32 * 60 * 1000);
  return () => {
    if (now() >= deadline) {
      throw holderError('HOLDER_RUN_BUDGET_EXHAUSTED', 'Holder run time budget exhausted at a safe checkpoint; resume next run');
    }
  };
}

function checkRunDeadline() {
  if (activeRunDeadline) activeRunDeadline();
}

function isTerminalHolderError(error) {
  return error && [HOLDER_STATE_PERSIST_FAILED, 'HOLDER_RUN_BUDGET_EXHAUSTED'].includes(error.code);
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value, spacing = 2) {
  ensureDirectory(path.dirname(filePath));
  const payload = JSON.stringify(value, null, spacing);
  const tempFilePath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  fs.writeFileSync(tempFilePath, `${payload}\n`);

  try {
    fs.renameSync(tempFilePath, filePath);
  } catch (error) {
    if (!error || (error.code !== 'EEXIST' && error.code !== 'EPERM')) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {
        // Best-effort cleanup for failed atomic writes.
      }
      throw error;
    }

    fs.rmSync(filePath, { force: true });
    fs.renameSync(tempFilePath, filePath);
  }
}

function isValidAddress(address) {
  return /^0x[0-9a-f]{40}$/.test(String(address || '').toLowerCase());
}

function toNonNegativeInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function parseRpcListValue(value) {
  if (!value || typeof value !== 'string') return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => String(entry || '').trim()).filter(Boolean);
    }
  } catch {
    // Treat invalid JSON as a delimited string.
  }

  return value
    .split(/[,\r\n; ]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseAddressList(value) {
  return parseRpcListValue(value).map((entry) => String(entry || '').toLowerCase()).filter(isValidAddress);
}

function getAlchemyRpcUrlsForChain(chain) {
  const network = ALCHEMY_NETWORKS[chain];
  if (!network || !ALCHEMY_API_KEY) return [];

  return [`https://${network}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`];
}

function getInfuraRpcUrlsForChain(chain) {
  const network = INFURA_NETWORKS[chain];
  if (!network || !BACKUP_INFURA_API_KEY) return [];
  return [`https://${network}.infura.io/v3/${BACKUP_INFURA_API_KEY}`];
}

function getChainstackRpcUrlsForChain(chain) {
  if (chain !== 'base' || !BACKUP_CHAINSTACK_BASE_RPC_URL) return [];
  return [BACKUP_CHAINSTACK_BASE_RPC_URL];
}

function normalizeHolderLabelRegistry(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const source =
    input.addresses && typeof input.addresses === 'object' && !Array.isArray(input.addresses)
      ? input.addresses
      : input;
  const labels = {};

  for (const [address, value] of Object.entries(source)) {
    const normalizedAddress = String(address || '').toLowerCase();
    if (!isValidAddress(normalizedAddress) || !value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    const label = typeof value.label === 'string' ? value.label.trim() : '';
    const category = typeof value.category === 'string' ? value.category.trim().toLowerCase() : '';
    const excludeFromRanking = value.excludeFromRanking === true;

    if (!label && !category && !excludeFromRanking) continue;

    labels[normalizedAddress] = {
      label: label || null,
      category: category || null,
      excludeFromRanking,
    };
  }

  return labels;
}

function readHolderLabelRegistry() {
  return normalizeHolderLabelRegistry(readJson(LABELS_FILE, {}));
}

function buildExcludedAddressSet(holderLabels) {
  const excluded = new Set([ZERO_ADDRESS, DEAD_ADDRESS]);

  for (const config of TOKEN_CONFIGS) {
    excluded.add(config.address);
  }

  for (const [address, metadata] of Object.entries(holderLabels || {})) {
    if (metadata && metadata.excludeFromRanking) {
      excluded.add(address);
    }
  }

  for (const key of EXCLUSION_ENV_KEYS) {
    for (const address of parseAddressList(process.env[key])) {
      excluded.add(address);
    }
  }

  return excluded;
}

function getRpcUrlsForChain(chain) {
  return [
    ...getAlchemyRpcUrlsForChain(chain),
    ...getInfuraRpcUrlsForChain(chain),
    ...getChainstackRpcUrlsForChain(chain),
  ];
}

function getAlchemyRpcUrlForChain(chain) {
  return getAlchemyRpcUrlsForChain(chain)[0] || null;
}

function computeRetryDelayMs(attempt, baseDelayMs, maxDelayMs) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
}

function parseRetryAfterMs(value, maxDelayMs, nowMs = Date.now()) {
  if (value == null || value === '') return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(maxDelayMs, Math.max(0, seconds * 1000));
  }

  const dateMs = Date.parse(String(value));
  if (!Number.isFinite(dateMs)) return null;
  return Math.min(maxDelayMs, Math.max(0, dateMs - nowMs));
}

function providerDisableKey(url, method) {
  return `${String(method || '')} ${String(url || '')}`;
}

function shouldDisableProviderForRun(error) {
  const status = Number((error && error.status) || Number.NaN);
  const code = String((error && error.code) || '').toUpperCase();
  const message = String((error && error.message) || '').toLowerCase();
  if ([401, 403, 429].includes(status)) return true;
  if (['RPC_UNAUTHORIZED', 'RPC_FORBIDDEN', 'RPC_RATE_LIMIT'].includes(code)) return true;
  if (/too many requests|rate limit|rate-limited|thrott|quota|forbidden|unauthorized/.test(message)) return true;
  // Range errors often quote the requested block numbers. A block containing
  // "429" is not evidence of throttling: keep this provider eligible for the
  // smaller range. Actual HTTP access errors and explicit rate/auth signals
  // above remain authoritative even if the message also mentions a range.
  if (['RPC_RANGE_LIMIT', 'RPC_RANGE_CEILING'].includes(code) || inferMaxLogRangeFromError(error) != null ||
      /block range|range (?:limit|too large)|query returned more than|response size (?:exceeded|limit)/.test(message)) return false;
  return /429/.test(message);
}

function disableProviderForRun(url, method, error) {
  if (!shouldDisableProviderForRun(error)) return false;
  const key = providerDisableKey(url, method);
  if (!disabledProviders.has(key)) {
    disabledProviders.set(key, {
      code: String((error && error.code) || 'RPC_PROVIDER_DISABLED'),
      message: String((error && error.message) || 'provider disabled for this run'),
    });
  }
  return true;
}

function getDisabledProviderInfo(url, method) {
  return disabledProviders.get(providerDisableKey(url, method)) || null;
}

async function requestWithRetries(url, options = {}, context = {}) {
  const maxAttempts = Math.max(1, Number(process.env.API_MAX_ATTEMPTS || 5));
  const maxRateLimitAttempts = Math.max(
    1,
    Math.min(maxAttempts, Number(process.env.API_RATE_LIMIT_MAX_ATTEMPTS || 2)),
  );
  const baseDelayMs = Math.max(50, Number(process.env.API_BASE_DELAY_MS || 500));
  const maxDelayMs = Math.max(baseDelayMs, Number(process.env.API_MAX_DELAY_MS || 30000));
  let rateLimitAttempts = 0;
  const method = String(context.method || 'unknown');

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      checkRunDeadline();
      await rpcRunUsage.beforeAttempt(url, method);
      rpcCallCount += 1;
      const response = await readRpcResponse(url, options);
      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        if (response.status === 429) {
          rateLimitAttempts += 1;
          if (rateLimitAttempts >= maxRateLimitAttempts) return response;
        } else if (attempt === maxAttempts) {
          return response;
        }

        retryCount += 1;
        const retryAfterMs = parseRetryAfterMs(
          response.headers && response.headers.get('retry-after'),
          maxDelayMs,
        );
        const waitMs = retryAfterMs != null && retryAfterMs > 0
          ? retryAfterMs
          : computeRetryDelayMs(attempt, baseDelayMs, maxDelayMs);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      return response;
    } catch (error) {
      if (isTerminalHolderError(error)) throw error;
      if (attempt === maxAttempts) throw error;

      retryCount += 1;
      const waitMs = computeRetryDelayMs(attempt, baseDelayMs, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw holderError('RPC_RETRIES_EXHAUSTED', `Request retries exhausted for ${url}`);
}

function isRpcQuantity(value) {
  return typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
}

function requireRpcResult(condition, message) {
  if (!condition) throw holderError('RPC_INVALID_RESPONSE', message);
}

function validateBlockHeader(value, expectedNumber) {
  requireRpcResult(value && typeof value === 'object' && !Array.isArray(value), 'Missing RPC block header');
  requireRpcResult(isRpcQuantity(value.number) && /^0x[0-9a-f]{64}$/i.test(value.hash || ''), 'Malformed RPC block header');
  const blockNumber = Number(BigInt(value.number));
  requireRpcResult(Number.isSafeInteger(blockNumber), 'Unsafe RPC block number');
  requireRpcResult(expectedNumber == null || blockNumber === expectedNumber, 'RPC returned the wrong block header');
  return { blockNumber, blockHash: value.hash.toLowerCase() };
}

function validateTransferLogs(logs, tokenAddress, fromBlock, toBlock) {
  requireRpcResult(Array.isArray(logs), 'eth_getLogs result must be an array');
  const seen = new Map();
  const blocks = new Map();
  for (const log of logs) {
    requireRpcResult(log && typeof log === 'object' && !Array.isArray(log), 'Malformed Transfer log');
    requireRpcResult(isValidAddress(log.address) && (!tokenAddress || log.address.toLowerCase() === tokenAddress.toLowerCase()), 'Unexpected Transfer log contract');
    requireRpcResult(Array.isArray(log.topics) && log.topics.length === 3 &&
      String(log.topics[0]).toLowerCase() === TRANSFER_TOPIC0 &&
      log.topics.slice(1).every((topic) => /^0x0{24}[0-9a-f]{40}$/i.test(topic)), 'Malformed Transfer log topics');
    requireRpcResult(/^0x[0-9a-f]{64}$/i.test(log.data || '') &&
      /^0x[0-9a-f]{64}$/i.test(log.blockHash || '') &&
      /^0x[0-9a-f]{64}$/i.test(log.transactionHash || '') &&
      isRpcQuantity(log.blockNumber) && isRpcQuantity(log.logIndex) && log.removed === false, 'Malformed or removed Transfer log');
    const block = Number(BigInt(log.blockNumber));
    requireRpcResult(Number.isSafeInteger(block) && (fromBlock == null || block >= fromBlock) &&
      (toBlock == null || block <= toBlock), 'Transfer log outside requested block range');
    const hash = log.blockHash.toLowerCase();
    requireRpcResult(!blocks.has(block) || blocks.get(block) === hash, 'Conflicting block hashes in Transfer logs');
    blocks.set(block, hash);
    const key = `${hash}:${BigInt(log.logIndex)}`;
    const fingerprint = JSON.stringify([log.transactionHash.toLowerCase(), log.address.toLowerCase(), log.topics.map((topic) => topic.toLowerCase()), log.data.toLowerCase()]);
    requireRpcResult(!seen.has(key) || seen.get(key).fingerprint === fingerprint, 'Conflicting duplicate Transfer log');
    if (!seen.has(key)) seen.set(key, { log, fingerprint });
  }
  return [...seen.values()].map(({ log }) => log).sort((left, right) =>
    Number(BigInt(left.blockNumber) - BigInt(right.blockNumber)) ||
    Number(BigInt(left.logIndex) - BigInt(right.logIndex)));
}

function validateAssetTransfersPage(result, tokenAddress, fromBlock, toBlock) {
  requireRpcResult(result && typeof result === 'object' && !Array.isArray(result) &&
    Array.isArray(result.transfers), 'Alchemy Transfers result must contain a transfers array');
  requireRpcResult(result.pageKey == null || (typeof result.pageKey === 'string' && result.pageKey.trim().length > 0), 'Malformed Alchemy page key');
  for (const transfer of result.transfers) {
    requireRpcResult(transfer && typeof transfer === 'object' && !Array.isArray(transfer) &&
      isValidAddress(transfer.from) && isValidAddress(transfer.to) &&
      typeof transfer.uniqueId === 'string' && transfer.uniqueId.length > 0 &&
      /^0x[0-9a-f]{64}$/i.test(transfer.hash || '') && isRpcQuantity(transfer.blockNum), 'Malformed Alchemy ERC-20 transfer');
    const raw = transfer.rawContract;
    requireRpcResult(raw && typeof raw === 'object' && !Array.isArray(raw) &&
      isValidAddress(raw.address) && (!tokenAddress || raw.address.toLowerCase() === tokenAddress.toLowerCase()) &&
      typeof raw.value === 'string' && /^0x[0-9a-f]+$/i.test(raw.value) && BigInt(raw.value) < 2n ** 256n,
    'Malformed Alchemy transfer raw contract');
    requireRpcResult(transfer.category === 'erc20', 'Unexpected Alchemy transfer category');
    const block = Number(BigInt(transfer.blockNum));
    requireRpcResult(Number.isSafeInteger(block) && (fromBlock == null || block >= fromBlock) &&
      (toBlock == null || block <= toBlock), 'Alchemy transfer outside requested block range');
  }
  return { transfers: result.transfers, pageKey: result.pageKey || null };
}

function parseRpcEnvelope(payload, method, params, requestId) {
  requireRpcResult(payload && typeof payload === 'object' && !Array.isArray(payload) &&
    payload.jsonrpc === '2.0' && payload.id === requestId, `Invalid JSON-RPC envelope for ${method}`);
  if (Object.prototype.hasOwnProperty.call(payload, 'error')) {
    requireRpcResult(!Object.prototype.hasOwnProperty.call(payload, 'result') && payload.error &&
      typeof payload.error.message === 'string', `Malformed JSON-RPC error for ${method}`);
    throw holderError('RPC_REMOTE_ERROR', `RPC ${method} error: ${payload.error.message}`);
  }
  requireRpcResult(Object.prototype.hasOwnProperty.call(payload, 'result') && payload.result != null,
    `Missing JSON-RPC result for ${method}`);
  const result = payload.result;
  if (method === 'eth_getLogs') {
    const filter = params[0] || {};
    return validateTransferLogs(result, filter.address, fromRpcHex(filter.fromBlock), fromRpcHex(filter.toBlock));
  }
  if (method === 'alchemy_getAssetTransfers') {
    const filter = params[0] || {};
    return validateAssetTransfersPage(result, filter.contractAddresses && filter.contractAddresses[0],
      fromRpcHex(filter.fromBlock), fromRpcHex(filter.toBlock));
  }
  if (method === 'eth_getBlockByNumber') {
    validateBlockHeader(result, isRpcQuantity(params[0]) ? fromRpcHex(params[0]) : undefined);
  } else if (method === 'eth_blockNumber') {
    requireRpcResult(isRpcQuantity(result) && Number.isSafeInteger(Number(BigInt(result))), 'Invalid eth_blockNumber result');
  } else if (method === 'eth_call' || method === 'eth_getCode') {
    requireRpcResult(typeof result === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(result), `Invalid ${method} hex result`);
  }
  return result;
}

async function rpcCall(chain, method, params, deps = {}) {
  const urls = deps.urls || getRpcUrlsForChain(chain);
  const request = deps.request || requestWithRetries;
  if (!urls.length) {
    throw new Error(
      `No RPC URL configured for ${chain}. Set ALCHEMY_API_KEY, BACKUP_INFURA_API_KEY, or BACKUP_CHAINSTACK_BASE_RPC_URL.`,
    );
  }

  let lastError = null;
  const providerErrors = [];
  const retryRangeCeilings = [];

  for (const url of providerCooldowns.order(urls, method)) {
    const disabledInfo = getDisabledProviderInfo(url, method);
    if (disabledInfo) {
      const disabledError = new Error(
        `Provider disabled for ${method} after ${disabledInfo.code}: ${disabledInfo.message}`,
      );
      disabledError.code = 'RPC_PROVIDER_DISABLED';
      providerErrors.push(disabledError);
      lastError = disabledError;
      continue;
    }

    const rangeSkip = providerRangeCeilings.getSkipDecision(chain, method, url, params);
    if (rangeSkip) {
      const rangeError = new Error(
        `Provider has a known eth_getLogs ceiling of ${rangeSkip.ceiling} blocks; requested ${rangeSkip.requestedSpan}`,
      );
      rangeError.code = 'RPC_RANGE_CEILING';
      rangeError.maxLogRange = rangeSkip.ceiling;
      providerErrors.push(rangeError);
      retryRangeCeilings.push(rangeSkip.ceiling);
      lastError = rangeError;
      continue;
    }

    try {
      const requestId = Date.now();
      const response = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          method,
          params,
        }),
      }, { method });

      if (!response.ok) {
        const text = await response.text();
        const error = holderError('RPC_HTTP_ERROR', `RPC HTTP ${response.status} ${response.statusText} at ${url}: ${text}`);
        error.status = response.status;
        if (response.status === 401) error.code = 'RPC_UNAUTHORIZED';
        else if (response.status === 403) error.code = 'RPC_FORBIDDEN';
        else if (response.status === 429) error.code = 'RPC_RATE_LIMIT';
        throw error;
      }

      const payload = await response.json();
      const result = parseRpcEnvelope(payload, method, params, requestId);
      providerCooldowns.succeeded(url, method);
      return result;
    } catch (error) {
      if (isTerminalHolderError(error)) throw error;
      providerCooldowns.failed(url, method, error);
      const inferredMaxRange = method === 'eth_getLogs' ? inferMaxLogRangeFromError(error) : null;
      const providerMaxRange = method === 'eth_getLogs'
        ? inferExplicitProviderRangeCeiling(error)
        : null;
      if (providerMaxRange != null) {
        providerRangeCeilings.remember(chain, method, url, providerMaxRange);
      }
      const disabled = disableProviderForRun(url, method, error);
      if (inferredMaxRange != null && !disabled) {
        retryRangeCeilings.push(inferredMaxRange);
      }
      providerErrors.push(error instanceof Error ? error : new Error(String(error)));
      lastError = error;
    }
  }

  const aggregate = holderError('RPC_ALL_PROVIDERS_FAILED',
    `RPC ${method} failed for ${chain}; providers tried: ${providerErrors
      .map((error) => error.message)
      .join(' | ')}`,
  );
  aggregate.code = (lastError && lastError.code) || 'RPC_ALL_PROVIDERS_FAILED';
  aggregate.providerErrors = providerErrors;
  const retryRangeCeiling = chooseRetryRangeCeiling(retryRangeCeilings);
  if (retryRangeCeiling != null) aggregate.maxLogRange = retryRangeCeiling;
  throw aggregate;
}

async function alchemyCall(chain, method, params) {
  const urls = getAlchemyRpcUrlsForChain(chain);
  if (!urls.length) {
    throw new Error(`Alchemy is not configured for ${chain}`);
  }

  let lastError = null;
  for (const url of providerCooldowns.order(urls, method)) {
    const disabledInfo = getDisabledProviderInfo(url, method);
    if (disabledInfo) {
      lastError = new Error(
        `Provider disabled for ${method} after ${disabledInfo.code}: ${disabledInfo.message}`,
      );
      continue;
    }

    try {
      const requestId = Date.now();
      const response = await requestWithRetries(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          method,
          params,
        }),
      }, { method });

      if (!response.ok) {
        const text = await response.text();
        const error = holderError('RPC_HTTP_ERROR',
          `Alchemy HTTP ${response.status} ${response.statusText} for ${method} at ${url}: ${text}`,
        );
        error.status = response.status;
        if (response.status === 401) error.code = 'RPC_UNAUTHORIZED';
        else if (response.status === 403) error.code = 'RPC_FORBIDDEN';
        else if (response.status === 429) error.code = 'RPC_RATE_LIMIT';
        throw error;
      }

      const payload = await response.json();
      const result = parseRpcEnvelope(payload, method, params, requestId);
      providerCooldowns.succeeded(url, method);
      return result;
    } catch (error) {
      if (isTerminalHolderError(error)) throw error;
      providerCooldowns.failed(url, method, error);
      disableProviderForRun(url, method, error);
      lastError = error;
    }
  }

  throw lastError || new Error(`Alchemy ${method} failed for ${chain}`);
}

function asRpcHex(blockNumber) {
  return `0x${Math.max(0, Math.floor(Number(blockNumber) || 0)).toString(16)}`;
}

function fromRpcHex(value) {
  if (typeof value !== 'string' || !value.startsWith('0x')) return Number.NaN;

  try {
    return Number(BigInt(value));
  } catch {
    return Number.NaN;
  }
}

// Providers commonly include their permitted eth_getLogs span in the error.
// Learning that exact ceiling avoids a long sequence of guaranteed failures
// while halving from the configured 20k window.
function inferMaxLogRangeFromError(error) {
  const attachedCeiling = Number(error && error.maxLogRange);
  if (Number.isFinite(attachedCeiling) && attachedCeiling > 0) {
    return Math.floor(attachedCeiling);
  }
  const message = error instanceof Error ? error.message : String(error || '');

  const rangeMatch = message.match(/up to a (\d+) block range/i);
  if (rangeMatch) {
    const parsed = Number(rangeMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }

  const suggestedRangeMatch = message.match(
    /should work:\s*\[(0x[0-9a-f]+),\s*(0x[0-9a-f]+)\]/i,
  );
  if (suggestedRangeMatch) {
    const start = fromRpcHex(suggestedRangeMatch[1]);
    const end = fromRpcHex(suggestedRangeMatch[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return Math.floor(end - start + 1);
    }
  }

  return null;
}

function createFallbackLogBudget(limitValue = process.env.HOLDER_RANKINGS_MAX_FALLBACK_LOG_WINDOWS) {
  const parsed = Number(limitValue || DEFAULT_MAX_FALLBACK_LOG_WINDOWS);
  const limit = Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_MAX_FALLBACK_LOG_WINDOWS;
  let used = 0;

  return {
    consume(chain, fromBlock, toBlock) {
      if (used >= limit) {
        const error = new Error(
          `[holder-rankings] fallback eth_getLogs budget exhausted after ${used} windows; ` +
          `next unscanned range is ${chain} ${fromBlock}-${toBlock}`,
        );
        error.code = 'HOLDER_LOG_BUDGET_EXHAUSTED';
        throw error;
      }
      used += 1;
    },
    get used() {
      return used;
    },
    limit,
  };
}

// Shared by all three chains so a provider-wide fallback incident has one
// bounded request-window budget for the entire updater process.
const fallbackLogBudget = createFallbackLogBudget();

async function getLatestBlockRpc(chain) {
  const value = await rpcCall(chain, 'eth_blockNumber', []);
  const latestBlock = fromRpcHex(value);
  if (!Number.isFinite(latestBlock)) {
    throw new Error(`Invalid eth_blockNumber result for ${chain}: ${value}`);
  }
  return latestBlock;
}

async function getBlockHeaderRpc(chain, tag) {
  const rpcTag = typeof tag === 'number' ? asRpcHex(tag) : tag;
  const result = await rpcCall(chain, 'eth_getBlockByNumber', [rpcTag, false]);
  return validateBlockHeader(result, typeof tag === 'number' ? tag : undefined);
}

async function contractExistsAtBlock(chain, address, blockNumber) {
  const code = await rpcCall(chain, 'eth_getCode', [address, asRpcHex(blockNumber)]);
  return typeof code === 'string' && code !== '0x' && code !== '0x0';
}

async function findContractDeploymentBlock(chain, address, latestBlock) {
  const existsAtLatest = await contractExistsAtBlock(chain, address, latestBlock);
  if (!existsAtLatest) {
    throw new Error(`Contract ${address} does not exist on ${chain} at block ${latestBlock}`);
  }

  let low = 0;
  let high = latestBlock;
  let earliest = latestBlock;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const exists = await contractExistsAtBlock(chain, address, mid);
    if (exists) {
      earliest = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return earliest;
}

async function fetchTransferLogs(chain, tokenAddress, fromBlock, toBlock) {
  const result = await rpcCall(chain, 'eth_getLogs', [
    {
      address: tokenAddress,
      fromBlock: asRpcHex(fromBlock),
      toBlock: asRpcHex(toBlock),
      topics: [TRANSFER_TOPIC0],
    },
  ]);

  return validateTransferLogs(result, tokenAddress, fromBlock, toBlock);
}

function normalizeTopicAddress(topicValue) {
  if (typeof topicValue !== 'string' || !topicValue.startsWith('0x') || topicValue.length < 66) {
    return '';
  }
  return `0x${topicValue.slice(-40)}`.toLowerCase();
}

function normalizePlainAddress(address) {
  const value = String(address || '').toLowerCase();
  return isValidAddress(value) ? value : '';
}

function getRawBalance(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' || value.trim() === '') return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function normalizePendingBalanceReconcile(chainState) {
  const raw = Array.isArray(chainState && chainState.pendingBalanceReconcile)
    ? chainState.pendingBalanceReconcile
    : [];
  const normalized = [];
  const seen = new Set();

  for (const address of raw) {
    const value = String(address || '').toLowerCase();
    if (!isValidAddress(value) || value === ZERO_ADDRESS || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  if (normalized.length > 0) {
    chainState.pendingBalanceReconcile = normalized;
  } else if (chainState && typeof chainState === 'object') {
    delete chainState.pendingBalanceReconcile;
  }
  return normalized;
}

function getPendingBalanceReconcile(state, chain) {
  const chainState = state.chains && state.chains[chain];
  if (!chainState || typeof chainState !== 'object') return [];
  return normalizePendingBalanceReconcile(chainState);
}

function enqueuePendingBalanceReconcile(state, chain, holder) {
  if (!isValidAddress(holder) || holder === ZERO_ADDRESS) return;
  if (!state.chains || typeof state.chains !== 'object') state.chains = {};
  const chainState =
    state.chains[chain] && typeof state.chains[chain] === 'object' ? state.chains[chain] : {};
  state.chains[chain] = chainState;
  const pending = normalizePendingBalanceReconcile(chainState);
  if (!pending.includes(holder)) pending.push(holder);
  chainState.pendingBalanceReconcile = pending;
}

function clearPendingBalanceReconcile(state, chain) {
  const chainState = state.chains && state.chains[chain];
  if (chainState && typeof chainState === 'object') {
    delete chainState.pendingBalanceReconcile;
  }
}

function setRawBalance(holders, holder, chain, nextBalance) {
  if (!isValidAddress(holder) || holder === ZERO_ADDRESS) return;
  if (nextBalance < 0n) {
    nextBalance = 0n;
  }

  const existing = holders[holder] && typeof holders[holder] === 'object' ? holders[holder] : {};
  if (nextBalance === 0n) {
    delete existing[chain];
  } else {
    existing[chain] = nextBalance.toString();
  }

  if (Object.keys(existing).length === 0) {
    delete holders[holder];
  } else {
    holders[holder] = existing;
  }
}

function applyTransferLog(state, chain, log) {
  const topics = Array.isArray(log && log.topics) ? log.topics : [];
  if (topics.length < 3 || String(topics[0] || '').toLowerCase() !== TRANSFER_TOPIC0) {
    return false;
  }

  const from = normalizeTopicAddress(topics[1]);
  const to = normalizeTopicAddress(topics[2]);
  let value = 0n;

  try {
    value = BigInt(log.data || '0x0');
  } catch {
    return false;
  }

  if (value <= 0n) return false;

  if (from && from !== ZERO_ADDRESS) {
    const nextFromBalance = getRawBalance(state.holders[from] && state.holders[from][chain]) - value;
    if (nextFromBalance < 0n) {
      // IXS balanceOf can change without Transfer events. Persist this retry
      // marker beside the clamped balance and block checkpoint so interruption
      // cannot make the zero placeholder permanent.
      enqueuePendingBalanceReconcile(state, chain, from);
    }
    setRawBalance(state.holders, from, chain, nextFromBalance);
  }

  if (to && to !== ZERO_ADDRESS) {
    const nextToBalance = getRawBalance(state.holders[to] && state.holders[to][chain]) + value;
    setRawBalance(state.holders, to, chain, nextToBalance);
  }

  return true;
}

function applyTransferDelta(state, chain, from, to, value) {
  if (value <= 0n) return false;

  if (from && from !== ZERO_ADDRESS) {
    const nextFromBalance = getRawBalance(state.holders[from] && state.holders[from][chain]) - value;
    if (nextFromBalance < 0n) enqueuePendingBalanceReconcile(state, chain, from);
    setRawBalance(state.holders, from, chain, nextFromBalance);
  }

  if (to && to !== ZERO_ADDRESS) {
    const nextToBalance = getRawBalance(state.holders[to] && state.holders[to][chain]) + value;
    setRawBalance(state.holders, to, chain, nextToBalance);
  }

  return true;
}

function applyAssetTransfer(state, chain, transfer) {
  if (!transfer || typeof transfer !== 'object') return false;

  const from = normalizePlainAddress(transfer.from);
  const to = normalizePlainAddress(transfer.to);
  const rawValue =
    transfer.rawContract && typeof transfer.rawContract === 'object'
      ? getRawBalance(transfer.rawContract.value)
      : 0n;

  return applyTransferDelta(state, chain, from, to, rawValue);
}

function addThousandsSeparators(value) {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatTokenAmount(rawValue, decimals, fractionDigits = 2) {
  const raw = BigInt(rawValue);
  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const fractionBase = 10n ** BigInt(fractionDigits);
  const rounded = (absolute * fractionBase + base / 2n) / base;
  const whole = rounded / fractionBase;
  const fraction = (rounded % fractionBase).toString().padStart(fractionDigits, '0');

  return `${negative ? '-' : ''}${addThousandsSeparators(whole.toString())}.${fraction}`;
}

function createDefaultState() {
  return {
    version: HOLDER_STATE_VERSION,
    updatedAt: null,
    chains: {},
    holders: {},
  };
}

function migrateLegacyState(state, rawVersion) {
  if (rawVersion >= HOLDER_STATE_VERSION) return;

  console.warn(
    `[holder-rankings] Migrating holder state v${rawVersion} -> v${HOLDER_STATE_VERSION}: clearing legacy balances and checkpoints for one accuracy-safe rebuild`,
  );
  // State v1 could durably checkpoint a clamped zero while its reconciliation
  // marker existed only in process memory. Reset every supported chain before
  // setting v2 so the first subsequent persistence cannot bless an unexamined
  // legacy checkpoint on a chain that has not rebuilt yet.
  for (const config of TOKEN_CONFIGS) {
    clearChainBalances(state, config.chain);
    const chainState = state.chains[config.chain];
    if (!chainState || typeof chainState !== 'object') continue;
    delete chainState.lastScannedBlock;
    delete chainState.latestBlockAtRun;
    delete chainState.processedLogCount;
    delete chainState.assetTransfersCursor;
    delete chainState.pendingBalanceReconcile;
  }
  state.version = HOLDER_STATE_VERSION;
  state.updatedAt = null;
}

function normalizeState(rawState) {
  const state = createDefaultState();
  if (!rawState || typeof rawState !== 'object') return state;

  const rawVersion = toNonNegativeInteger(rawState.version) || 1;
  state.version = rawVersion;
  if (typeof rawState.updatedAt === 'string') state.updatedAt = rawState.updatedAt;

  if (rawState.chains && typeof rawState.chains === 'object') {
    state.chains = rawState.chains;
  }

  if (rawState.holders && typeof rawState.holders === 'object') {
    state.holders = rawState.holders;
  }

  migrateLegacyState(state, rawVersion);

  for (const chainState of Object.values(state.chains)) {
    if (chainState && typeof chainState === 'object') {
      normalizePendingBalanceReconcile(chainState);
    }
  }

  return state;
}

function isStateIntegrityError(error) {
  return Boolean(error && typeof error.message === 'string' && error.message.includes('Negative balance computed for'));
}

function clearChainBalances(state, chain) {
  for (const [holder, chainBalances] of Object.entries(state.holders || {})) {
    if (!chainBalances || typeof chainBalances !== 'object') continue;
    if (!(chain in chainBalances)) continue;

    delete chainBalances[chain];
    if (Object.keys(chainBalances).length === 0) {
      delete state.holders[holder];
    }
  }
}

function resetChainForFullResync(state, chainState, chain, contractStartBlock, latestBlock) {
  clearChainBalances(state, chain);
  clearPendingBalanceReconcile(state, chain);
  chainState.contractStartBlock = contractStartBlock;
  chainState.latestBlockAtRun = latestBlock;
  chainState.processedLogCount = 0;
  delete chainState.lastScannedBlock;
  delete chainState.assetTransfersCursor;
}

function cloneJsonValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function snapshotChainState(state, chain) {
  const balances = {};

  for (const [holder, chainBalances] of Object.entries(state.holders || {})) {
    if (!chainBalances || typeof chainBalances !== 'object') continue;
    if (typeof chainBalances[chain] !== 'string') continue;
    balances[holder] = chainBalances[chain];
  }

  return {
    chainState:
      state.chains[chain] && typeof state.chains[chain] === 'object' ? cloneJsonValue(state.chains[chain]) : null,
    balances,
  };
}

function restoreChainSnapshot(state, chain, snapshot) {
  clearChainBalances(state, chain);

  if (!snapshot || !snapshot.chainState || typeof snapshot.chainState !== 'object') {
    delete state.chains[chain];
  } else {
    state.chains[chain] = cloneJsonValue(snapshot.chainState);
  }

  for (const [holder, balance] of Object.entries((snapshot && snapshot.balances) || {})) {
    const existing = state.holders[holder] && typeof state.holders[holder] === 'object' ? state.holders[holder] : {};
    existing[chain] = balance;
    state.holders[holder] = existing;
  }
}

function ensureChainState(state, config, latestBlock) {
  let chainState =
    state.chains[config.chain] && typeof state.chains[config.chain] === 'object'
      ? state.chains[config.chain]
      : {};

  state.chains[config.chain] = chainState;
  if (chainState.tokenAddress && chainState.tokenAddress.toLowerCase() !== config.address.toLowerCase()) {
    throw holderError('HOLDER_TOKEN_CHANGED', `Saved ${config.chain} holder state belongs to a different token`);
  }
  normalizePendingBalanceReconcile(chainState);
  chainState.tokenAddress = config.address;
  chainState.decimals = config.decimals;
  chainState.latestBlockAtRun = latestBlock;
  return chainState;
}

function persistState(state) {
  writeJson(STATE_FILE, state, 0);
}

function persistHolderState(state, persist = persistState) {
  try {
    persist(state);
  } catch (error) {
    const persistError = error instanceof Error ? error : new Error(String(error));
    persistError.code = HOLDER_STATE_PERSIST_FAILED;
    throw persistError;
  }
}

async function fetchAssetTransfersPage(chain, tokenAddress, fromBlock, toBlock, pageKey) {
  const params = {
    fromBlock: asRpcHex(fromBlock),
    toBlock: asRpcHex(toBlock),
    category: ['erc20'],
    contractAddresses: [tokenAddress],
    withMetadata: false,
    excludeZeroValue: true,
    order: 'asc',
    maxCount: asRpcHex(Math.max(1, Number(process.env.HOLDER_RANKINGS_ASSET_TRANSFERS_PAGE_SIZE || 1000))),
  };

  if (pageKey) {
    params.pageKey = pageKey;
  }

  const result = await alchemyCall(chain, 'alchemy_getAssetTransfers', [params]);
  return validateAssetTransfersPage(result, tokenAddress, fromBlock, toBlock);
}

async function processChainViaAlchemyAssetTransfers(state, chainState, config, latestBlock, contractStartBlock, deps = {}) {
  // deps.fetchPage / deps.persist are injectable for tests; production uses the
  // real Alchemy fetcher and the disk persister.
  const fetchPage = deps.fetchPage || fetchAssetTransfersPage;
  const persist = deps.persist || persistState;
  const checkDeadline = deps.checkDeadline || checkRunDeadline;
  // Checkpoint by block number, never by Alchemy pageKey. Alchemy pageKeys are
  // session-scoped: persisting one and replaying it in a later run silently
  // RESTARTS pagination from fromBlock, re-applying the whole history on top of
  // the existing balances (doubling them). Instead we scan bounded block
  // windows, fully paginating each window within THIS run (pageKey used only in
  // memory), and advance lastScannedBlock — a durable checkpoint — per window.
  const windowSize = Math.max(
    1,
    Number(process.env.HOLDER_RANKINGS_ASSET_TRANSFERS_BLOCK_WINDOW || 1_000_000),
  );
  // Drop any legacy pageKey cursor left by older versions of this script.
  if (chainState.assetTransfersCursor) delete chainState.assetTransfersCursor;

  const lastScannedBlock = toNonNegativeInteger(chainState.lastScannedBlock);
  const startBlock = lastScannedBlock == null ? contractStartBlock : lastScannedBlock + 1;

  if (startBlock > latestBlock) {
    console.log(
      `[holder-rankings] ${config.chain}: already synced at block ${lastScannedBlock} (latest ${latestBlock})`,
    );
    return { startBlock, latestBlock, logsFetched: 0, logsApplied: 0, mode: 'alchemy_getAssetTransfers' };
  }

  // A from-scratch scan (no durable checkpoint) must start from empty balances,
  // or it would re-add the full history on top of whatever is already present.
  if (lastScannedBlock == null) {
    clearChainBalances(state, config.chain);
    clearPendingBalanceReconcile(state, config.chain);
    chainState.processedLogCount = 0;
  }

  console.log(
    `[holder-rankings] ${config.chain}: scanning transfers ${startBlock}-${latestBlock} via alchemy_getAssetTransfers (window ${windowSize})`,
  );

  let logsFetched = 0;
  let logsApplied = 0;

  for (let from = startBlock; from <= latestBlock; ) {
    checkDeadline();
    const to = Math.min(latestBlock, from + windowSize - 1);

    // Paginate this window to completion within this run. pageKey lives only in
    // memory here and is never persisted.
    let pageKey = null;
    const seenPageKeys = new Set();
    const seenTransfers = new Map();
    let previousBlock = from;
    do {
      checkDeadline();
      const page = validateAssetTransfersPage(
        await fetchPage(config.chain, config.address, from, to, pageKey), config.address, from, to,
      );
      requireRpcResult(!page.pageKey || (!seenPageKeys.has(page.pageKey) && page.transfers.length > 0),
        'Alchemy pagination repeated a cursor or made no progress');
      if (page.pageKey) seenPageKeys.add(page.pageKey);
      for (const transfer of page.transfers) {
        const fingerprint = JSON.stringify([transfer.hash.toLowerCase(), transfer.blockNum.toLowerCase(),
          transfer.from.toLowerCase(), transfer.to.toLowerCase(), BigInt(transfer.rawContract.value).toString()]);
        const prior = seenTransfers.get(transfer.uniqueId);
        requireRpcResult(!prior || prior === fingerprint, 'Conflicting duplicate Alchemy transfer');
        if (prior) continue;
        requireRpcResult(Number(BigInt(transfer.blockNum)) >= previousBlock, 'Alchemy transfer pages are out of block order');
        previousBlock = Number(BigInt(transfer.blockNum));
        seenTransfers.set(transfer.uniqueId, fingerprint);
        if (applyAssetTransfer(state, config.chain, transfer)) {
          logsApplied += 1;
        }
        const processedLogCount = toNonNegativeInteger(chainState.processedLogCount) ?? 0;
        chainState.processedLogCount = processedLogCount + 1;
      }
      logsFetched += page.transfers.length;
      pageKey = page.pageKey;
    } while (pageKey);

    // Window complete: advance the durable checkpoint and persist. If the run is
    // interrupted between windows, the next run resumes from lastScannedBlock+1
    // (a block number), so nothing is ever re-applied.
    chainState.lastScannedBlock = to;
    chainState.latestBlockAtRun = latestBlock;
    from = to + 1;
    persistHolderState(state, persist);
    if (deps.onCheckpoint) deps.onCheckpoint();
  }

  return {
    startBlock,
    latestBlock,
    logsFetched,
    logsApplied,
    mode: 'alchemy_getAssetTransfers',
  };
}

function buildPublicPayload(state, holderLabels) {
  const limit = Math.max(1, Number(process.env.HOLDER_RANKINGS_LIMIT || DEFAULT_LIMIT));
  const excludedAddresses = buildExcludedAddressSet(holderLabels);
  const entries = [];

  for (const [holder, chainBalances] of Object.entries(state.holders || {})) {
    if (!isValidAddress(holder) || !chainBalances || typeof chainBalances !== 'object') continue;
    if (excludedAddresses.has(holder)) continue;

    let totalRaw = 0n;
    let chainsHolding = 0;

    for (const config of TOKEN_CONFIGS) {
      const rawBalance = getRawBalance(chainBalances[config.chain]);
      if (rawBalance > 0n) {
        totalRaw += rawBalance;
        chainsHolding += 1;
      }
    }

    if (totalRaw <= 0n) continue;
    entries.push({
      holder,
      totalRaw,
      chainsHolding,
      label: holderLabels && holderLabels[holder] ? holderLabels[holder].label : null,
    });
  }

  entries.sort((left, right) => {
    if (left.totalRaw === right.totalRaw) {
      return left.holder.localeCompare(right.holder);
    }
    return left.totalRaw > right.totalRaw ? -1 : 1;
  });

  return {
    ok: true,
    rows: entries.slice(0, limit).map((entry, index) => ({
      rank: index + 1,
      holder: entry.holder,
      chainsHolding: entry.chainsHolding,
      totalIxs: formatTokenAmount(entry.totalRaw, DEFAULT_TOKEN_DECIMALS, 2),
      label: entry.label,
    })),
    totalRowCount: entries.length,
    lastRefreshed: state.updatedAt || null,
    source: 'rpc-snapshot',
  };
}

async function processChainViaStandardRpcLogs(state, chainState, config, latestBlock, contractStartBlock, deps = {}) {
  // deps.fetchLogs / deps.persist are injectable for tests.
  const fetchLogs = deps.fetchLogs || fetchTransferLogs;
  const persist = deps.persist || persistState;
  const logBudget = deps.logBudget || fallbackLogBudget;
  const checkDeadline = deps.checkDeadline || checkRunDeadline;
  chainState.contractStartBlock = contractStartBlock;

  const lastScannedBlock = toNonNegativeInteger(chainState.lastScannedBlock);
  const startBlock = lastScannedBlock == null ? contractStartBlock : lastScannedBlock + 1;

  if (startBlock > latestBlock) {
    console.log(
      `[holder-rankings] ${config.chain}: already synced at block ${lastScannedBlock} (latest ${latestBlock})`,
    );
    return { startBlock, latestBlock, logsFetched: 0, logsApplied: 0 };
  }

  // A from-scratch scan must start from empty balances, or it would re-add the
  // full history on top of whatever is already present (this path checkpoints
  // per block chunk, so an interrupted scan resumes incrementally instead).
  if (lastScannedBlock == null) {
    clearChainBalances(state, config.chain);
    clearPendingBalanceReconcile(state, config.chain);
    chainState.processedLogCount = 0;
  }

  const maxChunk = Math.max(
    DEFAULT_MIN_LOG_CHUNK,
    Number(process.env.HOLDER_RANKINGS_LOG_CHUNK || DEFAULT_LOG_CHUNK),
  );
  const minChunk = Math.max(
    1,
    Math.min(maxChunk, Number(process.env.HOLDER_RANKINGS_MIN_LOG_CHUNK || DEFAULT_MIN_LOG_CHUNK)),
  );
  const saveEveryBatches = Math.max(
    1,
    Number(process.env.HOLDER_RANKINGS_SAVE_EVERY_BATCHES || DEFAULT_SAVE_EVERY_BATCHES),
  );

  let cursor = startBlock;
  let chunkSize = maxChunk;
  let learnedMaxChunk = maxChunk;
  let effectiveMinChunk = minChunk;
  let logsFetched = 0;
  let logsApplied = 0;
  let batchesSinceSave = 0;

  console.log(
    `[holder-rankings] ${config.chain}: scanning blocks ${startBlock}-${latestBlock} with chunk ${chunkSize}`,
  );

  while (cursor <= latestBlock) {
    const endBlock = Math.min(latestBlock, cursor + chunkSize - 1);

    let logs;
    try {
      checkDeadline();
      logBudget.consume(config.chain, cursor, endBlock);
      logs = validateTransferLogs(await fetchLogs(config.chain, config.address, cursor, endBlock),
        config.address, cursor, endBlock);
    } catch (error) {
      if (error && ['HOLDER_LOG_BUDGET_EXHAUSTED', 'HOLDER_RUN_BUDGET_EXHAUSTED', 'RPC_INVALID_RESPONSE'].includes(error.code)) {
        if (batchesSinceSave > 0) persistHolderState(state, persist);
        throw error;
      }

      const inferredMaxChunk = inferMaxLogRangeFromError(error);
      if (inferredMaxChunk != null) {
        learnedMaxChunk = Math.min(learnedMaxChunk, inferredMaxChunk);
        // An explicit provider ceiling is stronger evidence than the operator's
        // generic safety floor. Permit that exact smaller span, but never an
        // arbitrary shrink below the floor for unrelated errors.
        effectiveMinChunk = Math.min(effectiveMinChunk, inferredMaxChunk);
      }

      if (chunkSize <= effectiveMinChunk) {
        if (batchesSinceSave > 0) persistHolderState(state, persist);
        throw new Error(
          `[holder-rankings] ${config.chain}: failed scanning blocks ${cursor}-${endBlock}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const nextChunkSize = inferredMaxChunk != null
        ? Math.max(effectiveMinChunk, Math.min(chunkSize - 1, inferredMaxChunk))
        : Math.max(effectiveMinChunk, Math.floor(chunkSize / 2));
      console.warn(
        `[holder-rankings] ${config.chain}: reducing log chunk ${chunkSize} -> ${nextChunkSize} after RPC error`,
      );
      chunkSize = nextChunkSize;
      continue;
    }

    logsFetched += logs.length;

    for (const log of logs) {
      if (applyTransferLog(state, config.chain, log)) {
        logsApplied += 1;
      }
    }

    chainState.lastScannedBlock = endBlock;
    chainState.latestBlockAtRun = latestBlock;
    const processedLogCount = toNonNegativeInteger(chainState.processedLogCount) ?? 0;
    chainState.processedLogCount = processedLogCount + logs.length;

    batchesSinceSave += 1;
    if (batchesSinceSave >= saveEveryBatches) {
      // Persistence is deliberately outside the RPC range-recovery catch.
      // A failed durable write must terminate the run so the next invocation
      // reloads the last atomic checkpoint and replays this window exactly once.
      persistHolderState(state, persist);
      batchesSinceSave = 0;
    }

    cursor = endBlock + 1;

    const growCeiling = Math.min(maxChunk, learnedMaxChunk);
    if (logs.length === 0 && chunkSize < growCeiling) {
      chunkSize = Math.min(growCeiling, chunkSize * 2);
    }
  }

  persistHolderState(state, persist);

  return {
    startBlock,
    latestBlock,
    logsFetched,
    logsApplied,
  };
}

function balanceOfCallData(address) {
  return `0x70a08231000000000000000000000000${address.slice(2).toLowerCase()}`;
}

function parseBalanceOfResult(result) {
  if (typeof result !== 'string' || !/^0x[0-9a-f]{64}$/i.test(result)) {
    throw new Error(`invalid balanceOf result: ${result}`);
  }
  return BigInt(result);
}

function getReconcileBatchSize(value = process.env.HOLDER_RANKINGS_RECONCILE_BATCH_SIZE) {
  const configured = Number(value == null || value === '' ? DEFAULT_RECONCILE_BATCH_SIZE : value);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(1, Math.floor(configured))
    : DEFAULT_RECONCILE_BATCH_SIZE;
}

function applyAuthoritativeBalance(state, chain, address, raw) {
  const existing =
    state.holders[address] && typeof state.holders[address] === 'object' ? state.holders[address] : {};
  if (raw === 0n) {
    delete existing[chain];
  } else {
    existing[chain] = raw.toString();
  }
  if (Object.keys(existing).length === 0) {
    delete state.holders[address];
  } else {
    state.holders[address] = existing;
  }
}

// After a chain's transfer scan, replace flagged negative event-sums with
// authoritative balanceOf values at the exact durable scan checkpoint. The
// queue is persisted in chainState; only successful addresses are removed.
async function reconcileFlaggedBalances(state, config, chainState, deps = {}) {
  const addresses = [...getPendingBalanceReconcile(state, config.chain)];
  if (addresses.length === 0) return { reconciled: 0, failed: 0 };

  const scannedBlock = toNonNegativeInteger(chainState.lastScannedBlock);
  if (scannedBlock == null) {
    console.warn(
      `[holder-rankings] ${config.chain}: cannot reconcile ${addresses.length} queued address(es) without a durable lastScannedBlock; keeping them queued`,
    );
    return { reconciled: 0, failed: addresses.length };
  }

  const blockTag = asRpcHex(scannedBlock);
  const callRpc = deps.rpcCall || rpcCall;
  const persist = deps.persist || persistState;
  const checkDeadline = deps.checkDeadline || checkRunDeadline;
  const multicallAddress = String(
    process.env.MULTICALL3_ADDRESS || DEFAULT_MULTICALL3_ADDRESS,
  ).trim();
  const batchSize = getReconcileBatchSize();

  console.warn(
    `[holder-rankings] ${config.chain}: ${addresses.length} address(es) had a negative Transfer-event sum (expected for IXS, whose balanceOf is not the net of Transfer events); reconciling against on-chain balanceOf @ block ${scannedBlock}`,
  );

  const successful = new Map();
  for (let offset = 0; offset < addresses.length; offset += batchSize) {
    checkDeadline();
    const batchAddresses = addresses.slice(offset, offset + batchSize);
    const calls = batchAddresses.map((address) => ({
      target: config.address,
      allowFailure: true,
      callData: balanceOfCallData(address),
    }));
    let batchResults = null;

    try {
      const encoded = encodeAggregate3Call(calls);
      const result = await callRpc(
        config.chain,
        'eth_call',
        [{ to: multicallAddress, data: encoded }, blockTag],
      );
      batchResults = decodeAggregate3Result(result);
      if (batchResults.length !== batchAddresses.length) {
        throw new Error(
          `Multicall returned ${batchResults.length} results for ${batchAddresses.length} calls`,
        );
      }
    } catch (error) {
      if (isTerminalHolderError(error)) throw error;
      console.warn(
        `[holder-rankings] ${config.chain}: balanceOf Multicall3 batch failed; using individual reads @ block ${scannedBlock}: ${
          error && error.message ? error.message : String(error)
        }`,
      );
      batchResults = null;
    }

    for (let index = 0; index < batchAddresses.length; index += 1) {
      const address = batchAddresses[index];
      let raw = null;
      const batchResult = batchResults && batchResults[index];

      if (batchResult && batchResult.success) {
        try {
          raw = parseBalanceOfResult(batchResult.returnData);
        } catch {
          // Malformed successful subcalls get the same individual fallback as
          // explicit subcall failures.
        }
      }

      if (raw == null) {
        try {
          const result = await callRpc(
            config.chain,
            'eth_call',
            [{ to: config.address, data: balanceOfCallData(address) }, blockTag],
          );
          raw = parseBalanceOfResult(result);
        } catch (error) {
          if (isTerminalHolderError(error)) throw error;
          console.warn(
            `[holder-rankings] ${config.chain}: balanceOf reconciliation failed for ${address} (left queued at 0): ${
              error && error.message ? error.message : String(error)
            }`,
          );
        }
      }

      if (raw != null) successful.set(address, raw);
    }
  }

  for (const [address, raw] of successful) {
    applyAuthoritativeBalance(state, config.chain, address, raw);
  }
  const remaining = getPendingBalanceReconcile(state, config.chain).filter(
    (address) => !successful.has(address),
  );
  if (remaining.length > 0) {
    chainState.pendingBalanceReconcile = remaining;
  } else {
    delete chainState.pendingBalanceReconcile;
  }

  const reconciled = successful.size;
  const failed = addresses.length - reconciled;
  if (reconciled > 0) persistHolderState(state, persist);
  console.log(
    `[holder-rankings] ${config.chain}: reconciled ${reconciled} address(es) against chain${
      failed ? `, ${failed} failed (left at 0, queued for next run)` : ''
    }`,
  );
  return { reconciled, failed };
}

async function scanChainRange(state, config, deps = {}) {
  if (!isValidAddress(config.address)) {
    throw new Error(`Invalid token address for ${config.chain}: ${config.address}`);
  }

  const getLatestBlock = deps.getLatestBlock || getLatestBlockRpc;
  const getAlchemyRpcUrl = deps.getAlchemyRpcUrl || getAlchemyRpcUrlForChain;
  const persist = deps.persist || persistState;
  const latestBlock = await getLatestBlock(config.chain);
  let chainState = ensureChainState(state, config, latestBlock);

  let contractStartBlock =
    toNonNegativeInteger(chainState.contractStartBlock) ?? toNonNegativeInteger(process.env[config.startBlockEnv]);
  // Defensive: negative balances are reconciled (not thrown) since IXS isn't a
  // vanilla ERC-20, so this resync path is dormant — it only fires if some
  // other code path ever throws a state-integrity error.
  let hasRetriedFromScratch = false;
  let summary;

  while (true) {
    let attemptSnapshot = snapshotChainState(state, config.chain);

    try {
      if (getAlchemyRpcUrl(config.chain)) {
        if (contractStartBlock == null) {
          contractStartBlock = 0;
        }
        chainState.contractStartBlock = contractStartBlock;

        try {
          summary = await processChainViaAlchemyAssetTransfers(
            state,
            chainState,
            config,
            latestBlock,
            contractStartBlock,
            {
              ...deps.alchemyScan,
              checkDeadline: deps.checkDeadline || (deps.alchemyScan && deps.alchemyScan.checkDeadline),
              onCheckpoint: () => {
                attemptSnapshot = snapshotChainState(state, config.chain);
                if (deps.alchemyScan && deps.alchemyScan.onCheckpoint) deps.alchemyScan.onCheckpoint();
              },
            },
          );
          break;
        } catch (error) {
          if (error && error.code === HOLDER_STATE_PERSIST_FAILED) {
            throw error;
          }
          if (isStateIntegrityError(error)) {
            throw error;
          }

          const snapshotProcessedLogCount =
            attemptSnapshot.chainState && typeof attemptSnapshot.chainState === 'object'
              ? toNonNegativeInteger(attemptSnapshot.chainState.processedLogCount) ?? 0
              : 0;
          const currentProcessedLogCount = toNonNegativeInteger(chainState.processedLogCount) ?? 0;
          const hadPartialAlchemyProgress =
            currentProcessedLogCount > snapshotProcessedLogCount ||
            Boolean(
              chainState.assetTransfersCursor && typeof chainState.assetTransfersCursor.pageKey === 'string',
            );
          restoreChainSnapshot(state, config.chain, attemptSnapshot);
          chainState = ensureChainState(state, config, latestBlock);
          if (contractStartBlock != null) {
            chainState.contractStartBlock = contractStartBlock;
          }
          persistHolderState(state, persist);
          if (error && error.code === 'HOLDER_RUN_BUDGET_EXHAUSTED') throw error;

          console.warn(
            `[holder-rankings] ${config.chain}: alchemy_getAssetTransfers failed${
              hadPartialAlchemyProgress ? ' after rolling back partial progress' : ''
            }, falling back to standard RPC logs: ${error && error.message ? error.message : String(error)}`,
          );
        }
      }

      if (contractStartBlock == null) {
        console.log(`[holder-rankings] Resolving deployment block for ${config.chain} ${config.address}`);
        contractStartBlock = await findContractDeploymentBlock(config.chain, config.address, latestBlock);
      }

      summary = await processChainViaStandardRpcLogs(
        state,
        chainState,
        config,
        latestBlock,
        contractStartBlock,
        { ...deps.standardScan, checkDeadline: deps.checkDeadline || (deps.standardScan && deps.standardScan.checkDeadline) },
      );
      break;
    } catch (error) {
      if (!isStateIntegrityError(error) || hasRetriedFromScratch) {
        throw error;
      }

      console.warn(
        `[holder-rankings] ${config.chain}: detected incomplete saved state, clearing ${config.chain} balances and rebuilding from block ${contractStartBlock}`,
      );
      resetChainForFullResync(state, chainState, config.chain, contractStartBlock, latestBlock);
      persistHolderState(state, persist);
      hasRetriedFromScratch = true;
    }
  }

  const recon = await reconcileFlaggedBalances(state, config, chainState, {
    rpcCall: deps.reconcileRpcCall || deps.rpcCall,
    persist,
    checkDeadline: deps.checkDeadline,
  });
  if (recon.reconciled || recon.failed) {
    summary = { ...summary, reconciled: recon.reconciled, reconcileFailed: recon.failed };
  }
  return summary;
}

function captureCanonicalAnchor(state, chain, header) {
  const snapshot = snapshotChainState(state, chain);
  return {
    blockNumber: header.blockNumber,
    blockHash: header.blockHash,
    balances: snapshot.balances,
    pendingBalanceReconcile: getPendingBalanceReconcile(state, chain).slice(),
    processedLogCount: toNonNegativeInteger(snapshot.chainState.processedLogCount) || 0,
  };
}

function restoreCanonicalAnchor(state, chainState, chain, anchor) {
  clearChainBalances(state, chain);
  for (const [address, raw] of Object.entries(anchor.balances)) {
    applyAuthoritativeBalance(state, chain, address, BigInt(raw));
  }
  chainState.lastScannedBlock = anchor.blockNumber;
  chainState.processedLogCount = anchor.processedLogCount;
  chainState.pendingBalanceReconcile = anchor.pendingBalanceReconcile.slice();
  normalizePendingBalanceReconcile(chainState);
}

function validateCanonicalHeader(header) {
  requireRpcResult(header && Number.isSafeInteger(header.blockNumber) && header.blockNumber >= 0 &&
    /^0x[0-9a-f]{64}$/i.test(header.blockHash || ''), 'Invalid canonical holder checkpoint header');
}

function validateReorgState(reorg, chainState) {
  requireRpcResult(reorg && typeof reorg === 'object' && ['canonical', 'tail'].includes(reorg.phase), 'Invalid holder recovery phase');
  if (reorg.anchor) {
    validateCanonicalHeader(reorg.anchor);
    requireRpcResult(reorg.anchor.balances && typeof reorg.anchor.balances === 'object' && !Array.isArray(reorg.anchor.balances) &&
      Object.entries(reorg.anchor.balances).every(([address, raw]) => isValidAddress(address) && typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw)) &&
      Array.isArray(reorg.anchor.pendingBalanceReconcile) && reorg.anchor.pendingBalanceReconcile.every(isValidAddress) &&
      Number.isSafeInteger(reorg.anchor.processedLogCount) && reorg.anchor.processedLogCount >= 0, 'Invalid holder recovery balances');
  }
  if (reorg.phase === 'tail') {
    requireRpcResult(Boolean(reorg.anchor), 'Missing canonical holder baseline');
  } else {
    validateCanonicalHeader(reorg.canonicalTarget);
    const checkpoint = toNonNegativeInteger(chainState.lastScannedBlock);
    requireRpcResult(checkpoint == null || (checkpoint <= reorg.canonicalTarget.blockNumber &&
      (!reorg.anchor || checkpoint >= reorg.anchor.blockNumber)), 'Holder canonical progress is outside its recorded target');
  }
}

async function verifyCanonicalHeader(chain, expected, getBlockHeader) {
  validateCanonicalHeader(expected);
  const current = await getBlockHeader(chain, expected.blockNumber);
  validateCanonicalHeader(current);
  if (current.blockNumber !== expected.blockNumber || current.blockHash.toLowerCase() !== expected.blockHash.toLowerCase()) {
    throw holderError('HOLDER_CANONICAL_MISMATCH', `Canonical ${chain} checkpoint hash changed at block ${expected.blockNumber}; keeping the published snapshot and requiring recovery`);
  }
}

// Only the recent unfinalized tail is replayed. The canonical baseline and its
// pending reconciliation queue are persisted together. During a long canonical
// catch-up, its finalized target proves that completed windows can safely resume
// from their ordinary durable checkpoint without discarding already fetched work.
async function processChain(state, config, deps = {}) {
  const getBlockHeader = deps.getBlockHeader || getBlockHeaderRpc;
  const persist = deps.persist || persistState;
  const checkDeadline = deps.checkDeadline || checkRunDeadline;
  checkDeadline();
  const finalized = await getBlockHeader(config.chain, 'finalized');
  const latest = await getBlockHeader(config.chain, 'latest');
  validateCanonicalHeader(finalized);
  validateCanonicalHeader(latest);
  requireRpcResult(finalized.blockNumber <= latest.blockNumber, 'Finalized holder block is ahead of latest');
  let chainState = ensureChainState(state, config, latest.blockNumber);
  let reorg = chainState.reorg;

  if (reorg) {
    validateReorgState(reorg, chainState);
    if (reorg.anchor) {
      requireRpcResult(finalized.blockNumber >= reorg.anchor.blockNumber, 'RPC finalized head is behind the saved holder baseline');
      await verifyCanonicalHeader(config.chain, reorg.anchor, getBlockHeader);
    }
    if (reorg.phase === 'canonical') {
      requireRpcResult(finalized.blockNumber >= reorg.canonicalTarget.blockNumber, 'RPC finalized head is behind canonical holder progress');
      await verifyCanonicalHeader(config.chain, reorg.canonicalTarget, getBlockHeader);
    } else {
      restoreCanonicalAnchor(state, chainState, config.chain, reorg.anchor);
    }
  } else {
    // A legacy snapshot has no old block hash. Trust its existing balances once,
    // only after finality reaches its checkpoint; never replay history over them.
    // Hash checks from this point forward cannot diagnose pre-migration damage.
    const legacyBlock = toNonNegativeInteger(chainState.lastScannedBlock);
    let anchor = null;
    if (legacyBlock != null) {
      if (legacyBlock > finalized.blockNumber) {
        throw holderError('HOLDER_FINALITY_PENDING', `Waiting for ${config.chain} finality to reach saved holder block ${legacyBlock}`);
      }
      const legacyHeader = await getBlockHeader(config.chain, legacyBlock);
      validateCanonicalHeader(legacyHeader);
      requireRpcResult(legacyHeader.blockNumber === legacyBlock, 'RPC returned the wrong legacy holder checkpoint');
      const recon = await reconcileFlaggedBalances(state, config, chainState, {
        rpcCall: deps.reconcileRpcCall || deps.rpcCall, persist, checkDeadline,
      });
      if (recon.failed) throw holderError('HOLDER_RECONCILIATION_PENDING', 'Legacy holder balances remain queued for reconciliation');
      anchor = captureCanonicalAnchor(state, config.chain, legacyHeader);
    }
    reorg = { anchor, phase: 'canonical', canonicalTarget: finalized };
    chainState.reorg = reorg;
  }

  reorg.phase = 'canonical';
  reorg.canonicalTarget = finalized;
  persistHolderState(state, persist);
  const scanDeps = (target) => ({
    ...deps, getLatestBlock: async () => target,
    alchemyScan: { ...deps.alchemyScan, persist: (deps.alchemyScan && deps.alchemyScan.persist) || persist },
    standardScan: { ...deps.standardScan, persist: (deps.standardScan && deps.standardScan.persist) || persist },
    persist, checkDeadline,
  });
  const canonicalSummary = await scanChainRange(state, config, scanDeps(finalized.blockNumber));
  if (canonicalSummary.reconcileFailed) {
    throw holderError('HOLDER_RECONCILIATION_PENDING', 'Canonical holder balances remain queued for reconciliation');
  }
  chainState = state.chains[config.chain];
  reorg = chainState.reorg;
  // Recheck the target before blessing the newly collected baseline. A deep
  // inconsistency never replaces the prior public snapshot.
  await verifyCanonicalHeader(config.chain, finalized, getBlockHeader);
  reorg.anchor = captureCanonicalAnchor(state, config.chain, finalized);
  reorg.phase = 'tail';
  delete reorg.canonicalTarget;
  persistHolderState(state, persist);
  checkDeadline();
  const tailSummary = await scanChainRange(state, config, scanDeps(latest.blockNumber));
  if (tailSummary.reconcileFailed) {
    throw holderError('HOLDER_RECONCILIATION_PENDING', 'Recent holder balances remain queued for reconciliation');
  }
  // Detect a reorg during this run before publishing; the next invocation can
  // recover by replaying the tail from the already durable canonical baseline.
  try {
    await verifyCanonicalHeader(config.chain, latest, getBlockHeader);
  } catch (error) {
    chainState = state.chains[config.chain];
    restoreCanonicalAnchor(state, chainState, config.chain, chainState.reorg.anchor);
    persistHolderState(state, persist);
    throw error;
  }
  return {
    startBlock: canonicalSummary.startBlock,
    latestBlock: latest.blockNumber,
    latestBlockHash: latest.blockHash,
    logsFetched: canonicalSummary.logsFetched + tailSummary.logsFetched,
    logsApplied: canonicalSummary.logsApplied + tailSummary.logsApplied,
  };
}

async function verifyHolderPublication(state, pinnedHeads, deps = {}) {
  const getBlockHeader = deps.getBlockHeader || getBlockHeaderRpc;
  const persist = deps.persist || persistState;
  const checkDeadline = deps.checkDeadline || checkRunDeadline;
  for (const head of pinnedHeads) {
    checkDeadline();
    try {
      await verifyCanonicalHeader(head.chain, {
        blockNumber: head.latestBlock, blockHash: head.latestBlockHash,
      }, getBlockHeader);
    } catch (error) {
      const chainState = state.chains[head.chain];
      restoreCanonicalAnchor(state, chainState, head.chain, chainState.reorg.anchor);
      persistHolderState(state, persist);
      throw error;
    }
  }
}

async function main() {
  activeRunDeadline = createHolderRunDeadline();
  ensureDirectory(STATE_DIR);
  ensureDirectory(OUTPUT_DIR);

  const state = normalizeState(readJson(STATE_FILE, createDefaultState()));
  const holderLabels = readHolderLabelRegistry();
  const pinnedHeads = [];
  for (const config of TOKEN_CONFIGS) {
    const summary = await processChain(state, config);
    pinnedHeads.push({ chain: config.chain, ...summary });
    console.log(
      `[holder-rankings] ${config.chain}: scanned ${summary.startBlock}-${summary.latestBlock}, fetched ${summary.logsFetched} logs, applied ${summary.logsApplied}`,
    );
  }

  // Earlier chains can reorg while a later chain catches up. Check all pinned
  // heads again immediately before replacing the public snapshot.
  await verifyHolderPublication(state, pinnedHeads);
  const completedAt = new Date().toISOString();
  state.updatedAt = completedAt;
  persistHolderState(state);

  const publicPayload = buildPublicPayload(state, holderLabels);
  writeJson(OUTPUT_FILE, publicPayload, 2);

  console.log(
    `[holder-rankings] Wrote ${publicPayload.rows.length} rows (${publicPayload.totalRowCount} holders) to ${OUTPUT_FILE}`,
  );
  console.log(
    `[holder-rankings] Completed with ${rpcCallCount} RPC calls and ${retryCount} retries. Last refreshed: ${completedAt}`,
  );
}

function flushRpcUsageTelemetry() {
  try {
    const usage = { ...rpcRunUsage.snapshot(), retryCount };
    writeRpcUsageComponent(
      RPC_USAGE_FILE,
      'holderRankings',
      getRpcUsageRunId(),
      usage,
    );
    console.log(`[rpc-usage] holderRankings ${JSON.stringify(usage)}`);
  } catch (error) {
    try {
      console.warn(
        `[rpc-usage] Unable to finalize holderRankings telemetry: ${
          error && error.message ? error.message : String(error)
        }`,
      );
    } catch {
      // Telemetry is best-effort and must never alter the updater outcome.
    }
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error('[holder-rankings] Update failed:', sanitizeRpcMessage(error && error.stack ? error.stack : error));
      process.exitCode = 1;
    })
    .finally(flushRpcUsageTelemetry);
}

// Exported for unit tests (see tests/holderRankings.test.ts). Importing this
// module does not run the updater; main() only runs when invoked directly.
module.exports = {
  isValidAddress,
  toNonNegativeInteger,
  parseRpcListValue,
  parseAddressList,
  normalizeTopicAddress,
  normalizePlainAddress,
  getRawBalance,
  getPendingBalanceReconcile,
  enqueuePendingBalanceReconcile,
  setRawBalance,
  applyTransferDelta,
  applyAssetTransfer,
  addThousandsSeparators,
  formatTokenAmount,
  createDefaultState,
  normalizeState,
  ensureChainState,
  clearChainBalances,
  processChainViaAlchemyAssetTransfers,
  processChainViaStandardRpcLogs,
  requestWithRetries,
  parseRetryAfterMs,
  providerDisableKey,
  shouldDisableProviderForRun,
  disableProviderForRun,
  getDisabledProviderInfo,
  inferMaxLogRangeFromError,
  createFallbackLogBudget,
  persistHolderState,
  parseBalanceOfResult,
  getReconcileBatchSize,
  reconcileFlaggedBalances,
  processChain,
  verifyHolderPublication,
  scanChainRange,
  createHolderRunDeadline,
  validateTransferLogs,
  validateAssetTransfersPage,
  parseRpcEnvelope,
  validateBlockHeader,
  providerCooldowns,
  rpcCall,
  providerRangeCeilings,
  rpcRunUsage,
};
