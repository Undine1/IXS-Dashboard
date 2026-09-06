// Alchemy-backed updater: sums USDC transfers to/from a pair address
// using Alchemy Asset Transfers first, then RPC block lookups plus
// eth_getLogs as fallback (Infura, then Chainstack, then Alchemy as a
// last resort — Alchemy's enhanced APIs can be rate-limited while its
// core JSON-RPC still serves). Writes increments into
// public/data/pool_volume.json and updates a checkpoint.
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
      const key = trimmed.substring(0, idx).trim();
      let value = trimmed.substring(idx + 1).trim();
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
  } catch (e) {
    console.warn('Unable to load .env.local:', e && e.message);
  }
}

loadEnvLocal();

const ALCHEMY_API_KEY = String(process.env.ALCHEMY_API_KEY || '').trim();
const BACKUP_INFURA_API_KEY = String(process.env.BACKUP_INFURA_API_KEY || '').trim();
const BACKUP_CHAINSTACK_BASE_RPC_URL = String(process.env.BACKUP_CHAINSTACK_BASE_RPC_URL || '').trim();
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
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

const GLOBAL_USDC = (process.env.POLYGON_USDC || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174').toLowerCase();
const GLOBAL_PAIR = (process.env.PAIR_ADDRESS || '0xd093a031df30f186976a1e2936b16d95ca7919d6').toLowerCase();

const CHECKPOINT = path.join(__dirname, '..', 'public', 'data', 'pool_volume_checkpoint.json');
const POOL_FILE = path.join(__dirname, '..', 'public', 'data', 'pool_volume.json');
const RUNS_FILE = path.join(__dirname, '..', 'public', 'data', 'pool_volume_runs.json');
const ALERT_FILE = path.join(__dirname, '..', 'public', 'data', 'pool_volume_alert.json');
const RPC_USAGE_FILE = path.join(__dirname, '..', 'data', 'rpc_usage.json');

// global counters used by requestWithRetries and persisted to alert file
let apiCallCount = 0;
let retryCount = 0;
let totalPoolCount = 0;
let successfulPoolCount = 0;
let failedPoolCount = 0;
const latestBlockCache = new Map();
const latestBlockNumberCache = new Map();
const disabledProviders = new Map();
const providerRangeCeilings = createProviderRangeCeilingTracker();
const rpcRunUsage = createRpcRunUsageTracker();
const providerCooldowns = createProviderCooldowns();
const finalizedBlockCache = new Map();
let runDeadlineAt = Infinity;

function setRunDeadline(deadlineAt = Infinity) {
  runDeadlineAt = deadlineAt;
}

function assertRunBudget(waitMs = 0) {
  if (Date.now() + Math.max(0, waitMs) >= runDeadlineAt) {
    const error = new Error('Pool scan reached its cooperative run deadline; completed checkpoints are preserved');
    error.code = 'RPC_RUN_DEADLINE';
    throw error;
  }
}

function sanitizeRpcError(error) {
  const clean = new Error(sanitizeRpcMessage(error && error.message ? error.message : String(error)));
  for (const key of ['code', 'status', 'maxLogRange', 'suppressAlertFile', 'retryCountRecorded']) {
    if (error && error[key] !== undefined) clean[key] = error[key];
  }
  if (error && Array.isArray(error.providerErrors)) {
    clean.providerErrors = error.providerErrors.map((message) => sanitizeRpcMessage(message));
  }
  return clean;
}

function invalidRpcResponse(message) {
  const error = new Error(message);
  error.code = 'RPC_INVALID_RESPONSE';
  return error;
}

function validateRpcEnvelope(value, expectedId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.jsonrpc !== '2.0' || value.id !== expectedId) {
    throw invalidRpcResponse('Invalid JSON-RPC response envelope or request id');
  }
  const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
  if (hasResult === hasError) throw invalidRpcResponse('JSON-RPC response must contain exactly one result or error');
  if (hasError && (!value.error || typeof value.error !== 'object' ||
      !Number.isInteger(value.error.code) || typeof value.error.message !== 'string')) {
    throw invalidRpcResponse('Invalid JSON-RPC error envelope');
  }
  return value;
}

// Equal jitter: half the exponential step is a guaranteed floor, the other
// half is randomized. Full jitter (random 0..exp) can roll near-zero waits
// that burn retry attempts inside the same provider throttle window.
function computeRetryDelayMs(attempt, baseDelayMs, maxDelayMs) {
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

async function requestWithRetries(url, opts = {}, context = {}) {
  const maxAttempts = Number(process.env.API_MAX_ATTEMPTS || 5);
  const baseDelay = Number(process.env.API_BASE_DELAY_MS || 500); // ms
  const maxDelay = Number(process.env.API_MAX_DELAY_MS || 30000); // ms
  const method = String(context.method || 'unknown');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      assertRunBudget();
      await rpcRunUsage.beforeAttempt(url, method);
      assertRunBudget();
      apiCallCount += 1;
      const res = await readRpcResponse(url, opts, {
        timeoutMs: Math.min(Number(process.env.RPC_REQUEST_TIMEOUT_MS || 15000), runDeadlineAt - Date.now()),
      });

      // Retry on 429 or 5xx
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const ra = res.headers.get('retry-after');
        let waitMs = 0;
        if (ra) {
          const n = Number(ra);
          if (!Number.isNaN(n)) waitMs = n * 1000;
          else {
            const date = Date.parse(ra);
            if (!Number.isNaN(date)) waitMs = Math.max(0, date - Date.now());
          }
        }
        if (waitMs <= 0) {
          waitMs = computeRetryDelayMs(attempt, baseDelay, maxDelay);
        }
        // Cap header-derived waits: a large/hostile Retry-After must not stall
        // the run past the job timeout.
        waitMs = Math.min(waitMs, maxDelay);
        retryCount += 1;
        if (attempt === maxAttempts) {
          let responseText = '';
          try {
            responseText = sanitizeRpcMessage((await res.text()).replace(/\s+/g, ' ').trim());
          } catch {
            responseText = '';
          }
          const err = new Error(
            `Request ${getProviderLabel(url)} returned ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${
              responseText ? `: ${responseText}` : ''
            }; retries exhausted after ${maxAttempts} attempts`,
          );
          if (res.status === 401) err.code = 'RPC_UNAUTHORIZED';
          else if (res.status === 403) err.code = 'RPC_FORBIDDEN';
          else if (res.status === 429) err.code = 'RPC_RATE_LIMIT';
          else if (res.status === 408 || res.status === 504) err.code = 'RPC_TIMEOUT';
          else err.code = `RPC_HTTP_${res.status}`;
          err.status = res.status;
          err.suppressAlertFile = true;
          err.retryCountRecorded = true;
          throw err;
        }
        console.warn(`Request ${getProviderLabel(url)} returned ${res.status}; attempt ${attempt}/${maxAttempts}, retrying after ${waitMs}ms`);
        assertRunBudget(waitMs);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      return res;
    } catch (err) {
      err = sanitizeRpcError(err);
      if (err.code === 'RPC_RUN_DEADLINE') throw err;
      if (!(err && err.retryCountRecorded)) {
        retryCount += 1;
      }
      if (attempt === maxAttempts) {
        if (err && err.suppressAlertFile) {
          throw err;
        }
        // write alert file before throwing so workflow can detect
        try {
          const a = { alert: true, reasons: [`request-failed: ${getProviderLabel(url)}`, err && err.message], ts: new Date().toISOString(), apiCallCount, retryCount };
          fs.writeFileSync(ALERT_FILE, JSON.stringify(a, null, 2));
        } catch (e) {
          console.error('Failed to write alert file', e && e.message);
        }
        throw err;
      }
      const waitMs = computeRetryDelayMs(attempt, baseDelay, maxDelay);
      console.warn(`Request error for ${getProviderLabel(url)}; attempt ${attempt}/${maxAttempts}, retrying after ${waitMs}ms`, err && err.message);
      assertRunBudget(waitMs);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error('Unreachable: retries exhausted');
}

function classifyRpcErrorMessage(message) {
  const txt = String(message || '').toLowerCase();
  if (inferMaxLogRangeFromError(message) != null ||
      /block range|range.{0,30}(?:exceed|limit|large|wide)|(?:response|result|log).{0,30}(?:size|too many|limit|exceed)|too many (?:results|logs)/.test(txt)) {
    return 'RPC_RANGE_LIMIT';
  }
  if (/rate.?limit|too many requests|throughput|quota|thrott|compute units per second/.test(txt)) return 'RPC_RATE_LIMIT';
  if (txt.includes('timeout') || txt.includes('timed out')) return 'RPC_TIMEOUT';
  if (txt.includes('too many requests')) return 'RPC_RATE_LIMIT';
  return 'RPC_ERROR';
}

function shouldDisableProviderForRun(error) {
  const code = String((error && error.code) || '').toUpperCase();
  const status = Number((error && error.status) || Number.NaN);
  const message = String((error && error.message) || '').toLowerCase();
  if ([401, 403, 429].includes(status)) return true;
  if (code === 'RPC_RANGE_LIMIT' || code === 'RPC_RANGE_CEILING') return false;
  if (code === 'RPC_RATE_LIMIT' || code === 'RPC_FORBIDDEN' || code === 'RPC_UNAUTHORIZED') return true;
  return /429|too many requests|rate limit|rate-limited|thrott|quota|forbidden|unauthorized/.test(message);
}

// Disabling is scoped to (provider URL, RPC method), not the whole URL:
// Alchemy's enhanced APIs (alchemy_getAssetTransfers) rate-limit
// independently of its core JSON-RPC, so a 429 on one method must not
// poison the others for the rest of the run.
function providerDisableKey(url, method) {
  return `${String(method || '')} ${String(url || '')}`;
}

function disableProviderForRun(url, method, error) {
  const key = providerDisableKey(url, method);
  if (!url || disabledProviders.has(key)) {
    return disabledProviders.get(key) || null;
  }
  if (!shouldDisableProviderForRun(error)) {
    return null;
  }
  const info = {
    code: String((error && error.code) || 'RPC_PROVIDER_DISABLED'),
    message: String((error && error.message) || 'Provider disabled for run after repeated access errors'),
  };
  disabledProviders.set(key, info);
  console.warn(
    `[pool-volume] disabling provider ${getProviderLabel(url)} (${getProviderHost(url)}) for ${method} for the remainder of this run after ${info.code}: ${info.message}`,
  );
  return info;
}

function getDisabledProviderInfo(url, method) {
  return url ? disabledProviders.get(providerDisableKey(url, method)) || null : null;
}

function isProviderAccessError(error) {
  const parts = [
    (error && error.code) || '',
    (error && error.message) || '',
    ...((error && Array.isArray(error.providerErrors)) ? error.providerErrors : []),
  ];
  const text = parts.join(' ').toLowerCase();
  return /rpc_rate_limit|rpc_forbidden|rpc_unauthorized|429|403|401|too many requests|rate limit|rate-limited|thrott|quota|forbidden|unauthorized/.test(text);
}

function normalizeChain(chain) {
  const normalized = String(chain || '').trim().toLowerCase();
  if (!normalized) {
    const err = new Error('Missing chain configuration');
    err.code = 'CHAIN_MISSING';
    throw err;
  }
  if (!ALCHEMY_NETWORKS[normalized]) {
    const err = new Error(`Unsupported chain=${normalized}`);
    err.code = 'CHAIN_UNSUPPORTED';
    throw err;
  }
  return normalized;
}

function getAlchemyRpcUrlsForChain(chain) {
  const network = ALCHEMY_NETWORKS[normalizeChain(chain)];
  if (!ALCHEMY_API_KEY) return [];

  const urls = [];
  urls.push(`https://${network}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`);
  return urls;
}

function getInfuraRpcUrlsForChain(chain) {
  const network = INFURA_NETWORKS[normalizeChain(chain)];
  if (!network || !BACKUP_INFURA_API_KEY) return [];
  return [`https://${network}.infura.io/v3/${BACKUP_INFURA_API_KEY}`];
}

function getChainstackRpcUrlsForChain(chain) {
  const normalizedChain = normalizeChain(chain);
  if (normalizedChain !== 'base' || !BACKUP_CHAINSTACK_BASE_RPC_URL) return [];
  return [BACKUP_CHAINSTACK_BASE_RPC_URL];
}

// Keyless public endpoints, added as an extra fallback that doesn't share the
// keyed providers' throttling. Only Base has a viable one: mainnet.base.org is
// Coinbase's canonical node — authoritative, complete (validated against the
// pool's known transfers), reliable, and serves up to a 10k-block eth_getLogs
// range with no API key. No comparable free public endpoint exists for Polygon
// (all surveyed ones are key-walled, tiny-quota, tiny-range, or offline), so
// Polygon deliberately has none — an unverified aggregator must never feed the
// cumulative volume total. Override/extend via POOL_VOLUME_PUBLIC_<CHAIN>_RPCS
// (comma-separated) if a trusted endpoint becomes available.
const PUBLIC_RPCS = {
  base: ['https://mainnet.base.org'],
};
function getPublicRpcUrlsForChain(chain) {
  const normalized = normalizeChain(chain);
  const envOverride = String(process.env[`POOL_VOLUME_PUBLIC_${normalized.toUpperCase()}_RPCS`] || '').trim();
  if (envOverride) {
    return envOverride.split(',').map((u) => u.trim()).filter(Boolean);
  }
  return (PUBLIC_RPCS[normalized] || []).slice();
}

function getRpcUrlsForChain(chain) {
  return [
    ...getAlchemyRpcUrlsForChain(chain),
    ...getInfuraRpcUrlsForChain(chain),
    ...getChainstackRpcUrlsForChain(chain),
    // Public endpoints last for block lookups: the keyed providers serve these
    // cheap calls fine; this is just a rescue if they're all throttled.
    ...getPublicRpcUrlsForChain(chain),
  ];
}

function getLogScanRpcUrlsForChain(chain) {
  // Infura and Chainstack first so chunked log scans don't spend the Alchemy
  // key's throughput. Then the keyless public endpoint (Base only) — it's
  // reliable, independent of the keyed providers' throttling, and serves large
  // ranges, so it rescues a scan when the keyed providers are all rate-limited
  // WITHOUT the Alchemy free-tier 10-block grind. Alchemy stays the final
  // last-resort (its core RPC has survived Asset Transfers throttling events).
  return [
    ...getInfuraRpcUrlsForChain(chain),
    ...getChainstackRpcUrlsForChain(chain),
    ...getPublicRpcUrlsForChain(chain),
    ...getAlchemyRpcUrlsForChain(chain),
  ];
}

async function alchemyCall(chain, method, params) {
  const urls = getAlchemyRpcUrlsForChain(chain);
  if (!urls.length) {
    const err = new Error(`Alchemy is not configured for chain=${chain}`);
    err.code = 'ALCHEMY_MISSING_URL';
    throw err;
  }

  let lastErr = null;
  const providerErrors = [];
  for (const url of providerCooldowns.order(urls, method)) {
    const providerLabel = getProviderLabel(url);
    const providerHost = getProviderHost(url);
    const disabledInfo = getDisabledProviderInfo(url, method);
    if (disabledInfo) {
      const err = new Error(`Provider disabled for run after ${disabledInfo.code}: ${disabledInfo.message}`);
      err.code = 'RPC_PROVIDER_DISABLED';
      err.providerCode = disabledInfo.code;
      providerErrors.push(`${providerLabel}@${providerHost} code=${err.code} msg=${err.message}`);
      lastErr = err;
      continue;
    }
    try {
      const payload = { jsonrpc: '2.0', id: 1, method, params };
      const res = await requestWithRetries(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, { method });
      if (!res.ok) {
        let responseText = '';
        try {
          responseText = (await res.text()).replace(/\s+/g, ' ').trim();
        } catch {
          responseText = '';
        }
        const err = new Error(
          sanitizeRpcMessage(`Alchemy HTTP ${res.status} ${res.statusText} at ${url}${responseText ? `: ${responseText}` : ''}`),
        );
        err.code = `ALCHEMY_HTTP_${res.status}`;
        err.status = res.status;
        throw err;
      }
      const j = validateRpcEnvelope(await res.json(), payload.id);
      if (j && j.error) {
        const msg = j.error.message || JSON.stringify(j.error);
        const err = new Error(sanitizeRpcMessage(`Alchemy ${method} error at ${url}: ${msg}`));
        err.code = classifyRpcErrorMessage(msg);
        throw err;
      }
      validateRpcMethodResult(method, params, j.result);
      providerCooldowns.succeeded(url, method);
      return j.result;
    } catch (e) {
      e = sanitizeRpcError(e);
      if (e.code === 'RPC_RUN_DEADLINE') throw e;
      providerErrors.push(`${providerLabel}@${providerHost} code=${(e && e.code) || 'unknown'} msg=${(e && e.message) || String(e)}`);
      console.warn(`[pool-volume] ${chain} ${method}: provider ${providerLabel} (${providerHost}) failed: ${(e && e.message) || String(e)}`);
      disableProviderForRun(url, method, e);
      providerCooldowns.failed(url, method, e);
      lastErr = e;
      continue;
    }
  }

  if (providerErrors.length > 0) {
    const aggregate = new Error(
      `Alchemy call failed for chain=${chain} method=${method}; providers tried: ${providerErrors.join(' | ')}`,
    );
    aggregate.code = (lastErr && lastErr.code) || 'ALCHEMY_ALL_PROVIDERS_FAILED';
    aggregate.providerErrors = providerErrors;
    throw aggregate;
  }

  throw lastErr || new Error(`Alchemy call failed for ${method}`);
}

function asRpcHex(n) {
  return `0x${Math.max(0, Math.floor(Number(n) || 0)).toString(16)}`;
}

function fromRpcHex(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return Number.NaN;
  try {
    const parsed = Number(BigInt(value));
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function addrToTopic(addr) {
  return `0x000000000000000000000000${String(addr || '')
    .toLowerCase()
    .replace(/^0x/, '')}`;
}

function logKey(log) {
  return `${String(log.transactionHash).toLowerCase()}:${fromRpcHex(log.logIndex)}`;
}

const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const RAW_VALUE_PATTERN = /^0x[0-9a-f]+$/i;

function transferFingerprint(transfer) {
  return JSON.stringify([
    String(transfer.hash).toLowerCase(), fromRpcHex(transfer.blockNum),
    String(transfer.from).toLowerCase(), String(transfer.to).toLowerCase(),
    String(transfer.rawContract.address).toLowerCase(), String(getAssetTransferRawValue(transfer)),
  ]);
}

function logFingerprint(log) {
  return JSON.stringify([
    logKey(log), String(log.blockHash).toLowerCase(), fromRpcHex(log.blockNumber),
    String(log.address).toLowerCase(), log.topics.map((topic) => topic.toLowerCase()), String(BigInt(log.data)),
  ]);
}

function validateRpcMethodResult(method, params, result) {
  if (method === 'eth_blockNumber') {
    if (!Number.isFinite(fromRpcHex(result))) throw invalidRpcResponse('Invalid eth_blockNumber result');
    return;
  }
  if (method === 'eth_getBlockByNumber') {
    if (!result || !Number.isFinite(fromRpcHex(result.number)) ||
        !Number.isFinite(fromRpcHex(result.timestamp)) || !HASH_PATTERN.test(result.hash)) {
      throw invalidRpcResponse('Missing or invalid block header');
    }
    if (RAW_VALUE_PATTERN.test(params[0]) && fromRpcHex(result.number) !== fromRpcHex(params[0])) {
      throw invalidRpcResponse('Block header does not match the requested block');
    }
    return;
  }
  if (method === 'eth_getLogs') {
    if (!Array.isArray(result)) throw invalidRpcResponse('eth_getLogs result must be an array');
    const filter = params[0];
    const seen = new Set();
    for (const log of result) {
      if (!log || !HASH_PATTERN.test(log.transactionHash) || !HASH_PATTERN.test(log.blockHash) ||
          !Number.isFinite(fromRpcHex(log.logIndex)) || !Number.isFinite(fromRpcHex(log.blockNumber)) ||
          !HASH_PATTERN.test(log.data) || !isValidAddress(log.address) ||
          !Array.isArray(log.topics) || log.topics.length !== 3 ||
          log.topics.some((topic) => !HASH_PATTERN.test(topic)) || log.removed !== false) {
        throw invalidRpcResponse('Malformed ERC-20 transfer log');
      }
      const block = fromRpcHex(log.blockNumber);
      if (block < fromRpcHex(filter.fromBlock) || block > fromRpcHex(filter.toBlock) ||
          (filter.address && log.address.toLowerCase() !== String(filter.address).toLowerCase()) ||
          (filter.topics || []).some((topic, index) => topic != null && log.topics[index].toLowerCase() !== topic.toLowerCase())) {
        throw invalidRpcResponse('Transfer log does not match the requested filter');
      }
      const key = logKey(log);
      if (seen.has(key)) throw invalidRpcResponse('Duplicate transfer log in one RPC result');
      seen.add(key);
    }
    return;
  }
  if (method === 'alchemy_getAssetTransfers') {
    if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.transfers) ||
        (result.pageKey != null && typeof result.pageKey !== 'string')) {
      throw invalidRpcResponse('Invalid Asset Transfers page');
    }
    const filter = params[0];
    const seen = new Set();
    for (const transfer of result.transfers) {
      const block = fromRpcHex(transfer && transfer.blockNum);
      if (!transfer || !HASH_PATTERN.test(transfer.hash) || !Number.isFinite(block) ||
          !isValidAddress(transfer.from) || !isValidAddress(transfer.to) || transfer.category !== 'erc20' ||
          !transfer.rawContract || !isValidAddress(transfer.rawContract.address) ||
          !RAW_VALUE_PATTERN.test(transfer.rawContract.value)) {
        throw invalidRpcResponse('Malformed Asset Transfers ERC-20 event');
      }
      const key = getAssetTransferKey(transfer);
      if (block < fromRpcHex(filter.fromBlock) || block > fromRpcHex(filter.toBlock) ||
          !filter.contractAddresses.some((address) => address.toLowerCase() === transfer.rawContract.address.toLowerCase()) ||
          (filter.fromAddress && transfer.from.toLowerCase() !== filter.fromAddress.toLowerCase()) ||
          (filter.toAddress && transfer.to.toLowerCase() !== filter.toAddress.toLowerCase())) {
        throw invalidRpcResponse('Asset transfer does not match the requested filter');
      }
      if (seen.has(key)) throw invalidRpcResponse('Duplicate event in one Asset Transfers page');
      seen.add(key);
    }
  }
}

function getProviderHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || 'unknown-provider');
  }
}

function getProviderLabel(url) {
  const host = getProviderHost(url).toLowerCase();
  if (host.includes('alchemy')) return 'alchemy';
  if (host.includes('infura')) return 'infura';
  if (host.includes('chainstack')) return 'chainstack';
  return host || 'unknown';
}

async function rpcCallWithUrls(chain, method, params, urls, missingUrlCode = 'RPC_MISSING_URL', missingUrlMessage = null) {
  if (!urls.length) {
    const err = new Error(missingUrlMessage || `No RPC URL configured for chain=${chain}`);
    err.code = missingUrlCode;
    throw err;
  }

  let lastErr = null;
  const providerErrors = [];
  const retryRangeCeilings = [];
  for (const url of providerCooldowns.order(urls, method)) {
    const providerLabel = getProviderLabel(url);
    const providerHost = getProviderHost(url);
    const disabledInfo = getDisabledProviderInfo(url, method);
    if (disabledInfo) {
      const err = new Error(`Provider disabled for run after ${disabledInfo.code}: ${disabledInfo.message}`);
      err.code = 'RPC_PROVIDER_DISABLED';
      err.providerCode = disabledInfo.code;
      providerErrors.push(`${providerLabel}@${providerHost} code=${err.code} msg=${err.message}`);
      lastErr = err;
      continue;
    }

    const rangeSkip = providerRangeCeilings.getSkipDecision(chain, method, url, params);
    if (rangeSkip) {
      const err = new Error(
        `Provider has a known eth_getLogs ceiling of ${rangeSkip.ceiling} blocks; requested ${rangeSkip.requestedSpan}`,
      );
      err.code = 'RPC_RANGE_CEILING';
      err.maxLogRange = rangeSkip.ceiling;
      providerErrors.push(`${providerLabel}@${providerHost} code=${err.code} msg=${err.message}`);
      retryRangeCeilings.push(rangeSkip.ceiling);
      lastErr = err;
      continue;
    }

    try {
      const payload = { jsonrpc: '2.0', id: 1, method, params };
      const res = await requestWithRetries(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, { method });
      if (!res.ok) {
        let responseText = '';
        try {
          responseText = (await res.text()).replace(/\s+/g, ' ').trim();
        } catch {
          responseText = '';
        }
        const err = new Error(
          sanitizeRpcMessage(`RPC HTTP ${res.status} ${res.statusText} at ${url}${responseText ? `: ${responseText}` : ''}`),
        );
        if (res.status === 401) err.code = 'RPC_UNAUTHORIZED';
        else if (res.status === 403) err.code = 'RPC_FORBIDDEN';
        else if (res.status === 429) err.code = 'RPC_RATE_LIMIT';
        else if (res.status === 408 || res.status === 504) err.code = 'RPC_TIMEOUT';
        else if (res.status === 400 && classifyRpcErrorMessage(responseText) === 'RPC_RANGE_LIMIT') err.code = 'RPC_RANGE_LIMIT';
        else err.code = `RPC_HTTP_${res.status}`;
        err.status = res.status;
        throw err;
      }
      const j = validateRpcEnvelope(await res.json(), payload.id);
      if (j && j.error) {
        const msg = j.error.message || JSON.stringify(j.error);
        const err = new Error(sanitizeRpcMessage(`RPC ${method} error at ${url}: ${msg}`));
        err.code = classifyRpcErrorMessage(msg);
        throw err;
      }
      validateRpcMethodResult(method, params, j.result);
      providerCooldowns.succeeded(url, method);
      if (providerErrors.length > 0) {
        console.warn(
          `[pool-volume] ${chain} ${method}: using fallback provider ${providerLabel} (${providerHost}) after previous failures: ${providerErrors.join(' | ')}`,
        );
      }
      return j.result;
    } catch (e) {
      e = sanitizeRpcError(e);
      if (e.code === 'RPC_RUN_DEADLINE') throw e;
      const code = (e && e.code) || 'unknown';
      const message = (e && e.message) || String(e);
      providerErrors.push(`${providerLabel}@${providerHost} code=${code} msg=${message}`);
      console.warn(`[pool-volume] ${chain} ${method}: provider ${providerLabel} (${providerHost}) failed: ${message}`);
      const inferredMaxRange = method === 'eth_getLogs' ? inferMaxLogRangeFromError(e) : null;
      const providerMaxRange = method === 'eth_getLogs'
        ? inferExplicitProviderRangeCeiling(e)
        : null;
      if (providerMaxRange != null) {
        providerRangeCeilings.remember(chain, method, url, providerMaxRange);
      }
      const disabled = disableProviderForRun(url, method, e);
      providerCooldowns.failed(url, method, e);
      if (inferredMaxRange != null && !disabled) {
        retryRangeCeilings.push(inferredMaxRange);
      }
      lastErr = e;
      continue;
    }
  }

  const aggregate = new Error(
    `RPC call failed for chain=${chain} method=${method}; providers tried: ${providerErrors.join(' | ')}`,
  );
  aggregate.code = (lastErr && lastErr.code) || 'RPC_ALL_PROVIDERS_FAILED';
  aggregate.providerErrors = providerErrors;
  const retryRangeCeiling = chooseRetryRangeCeiling(retryRangeCeilings);
  if (retryRangeCeiling != null) aggregate.maxLogRange = retryRangeCeiling;
  throw aggregate;
}

async function rpcCall(chain, method, params) {
  return rpcCallWithUrls(chain, method, params, getRpcUrlsForChain(chain));
}

async function getLatestBlockRpc(chain) {
  const hex = await rpcCall(chain, 'eth_blockNumber', []);
  const n = fromRpcHex(hex);
  if (!Number.isFinite(n)) {
    const err = new Error(`Invalid eth_blockNumber result for chain=${chain}: ${hex}`);
    err.code = 'RPC_INVALID_BLOCK';
    throw err;
  }
  return n;
}

async function getLatestBlockNumberForRun(chain) {
  if (latestBlockNumberCache.has(chain)) {
    return latestBlockNumberCache.get(chain);
  }

  const latestNumber = await getLatestBlockRpc(chain);
  latestBlockNumberCache.set(chain, latestNumber);
  return latestNumber;
}

async function getLatestBlockState(chain) {
  if (latestBlockCache.has(chain)) {
    return latestBlockCache.get(chain);
  }

  const latestNumber = await getLatestBlockNumberForRun(chain);
  const latestBlock = await getBlockByNumberRpc(chain, latestNumber);
  latestBlockCache.set(chain, latestBlock);
  return latestBlock;
}

async function getFinalizedBlockState(chain) {
  if (!finalizedBlockCache.has(chain)) {
    const block = await rpcCall(chain, 'eth_getBlockByNumber', ['finalized', false]);
    finalizedBlockCache.set(chain, {
      number: fromRpcHex(block.number), timestamp: fromRpcHex(block.timestamp), hash: block.hash.toLowerCase(),
    });
  }
  return finalizedBlockCache.get(chain);
}

async function getBlockByNumberRpc(chain, blockNumber) {
  const block = await rpcCall(chain, 'eth_getBlockByNumber', [asRpcHex(blockNumber), false]);
  if (!block || block.number == null || block.timestamp == null) {
    const err = new Error(`Missing block data for chain=${chain}, block=${blockNumber}`);
    err.code = 'RPC_INVALID_BLOCK';
    throw err;
  }
  const num = fromRpcHex(block.number);
  const ts = fromRpcHex(block.timestamp);
  if (!Number.isFinite(num) || !Number.isFinite(ts)) {
    const err = new Error(`Invalid block fields for chain=${chain}, block=${blockNumber}`);
    err.code = 'RPC_INVALID_BLOCK';
    throw err;
  }
  return { number: num, timestamp: ts, hash: block.hash.toLowerCase() };
}

// Free-tier eth_getLogs providers cap the block span per request (Alchemy's
// free plan is 10 blocks) and report the ceiling in the error body, e.g.
// "you can make eth_getLogs requests with up to a 10 block range. Based on
// your parameters, this block range should work: [0x.., 0x..]". Parse that
// ceiling so the scan can drop straight to a compliant chunk instead of
// blindly halving. Returns null when no range hint is present.
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

  const suggestedRangeMatch = message.match(/should work:\s*\[(0x[0-9a-f]+),\s*(0x[0-9a-f]+)\]/i);
  if (suggestedRangeMatch) {
    const start = fromRpcHex(suggestedRangeMatch[1]);
    const end = fromRpcHex(suggestedRangeMatch[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return Math.floor(end - start + 1);
    }
  }

  return null;
}

async function fetchTransferLogsRpc(chain, usdcAddr, fromBlock, endBlock, pairTopic, incoming) {
  const topics = incoming ? [TRANSFER_TOPIC0, null, pairTopic] : [TRANSFER_TOPIC0, pairTopic];
  const params = [
    {
      address: usdcAddr,
      fromBlock: asRpcHex(fromBlock),
      toBlock: asRpcHex(endBlock),
      topics,
    },
  ];
  const logs = await rpcCallWithUrls(
    chain,
    'eth_getLogs',
    params,
    getLogScanRpcUrlsForChain(chain),
    'RPC_LOG_FALLBACK_MISSING_URL',
    `No log-scan fallback configured for chain=${chain}. Set BACKUP_INFURA_API_KEY or BACKUP_CHAINSTACK_BASE_RPC_URL.`,
  );
  return logs;
}

function getAssetTransferKey(transfer) {
  if (transfer && typeof transfer.uniqueId === 'string' && transfer.uniqueId) {
    return transfer.uniqueId;
  }

  const txHash = String((transfer && transfer.hash) || '').toLowerCase();
  const logIndex = String(
    (transfer && transfer.logIndex) ??
    (transfer && transfer.rawContract && transfer.rawContract.logIndex) ??
    '',
  ).toLowerCase();
  if (HASH_PATTERN.test(txHash) && Number.isFinite(fromRpcHex(logIndex))) {
    return `${txHash}:${fromRpcHex(logIndex)}`;
  }
  throw invalidRpcResponse('Asset transfer is missing a unique event identity');
}

function getAssetTransferRawValue(transfer) {
  const value = transfer && transfer.rawContract && transfer.rawContract.value;
  if (!RAW_VALUE_PATTERN.test(value)) throw invalidRpcResponse('Invalid raw ERC-20 transfer value');
  return BigInt(value);
}

async function fetchPoolAssetTransfersPage(chain, usdcAddr, pairAddr, fromBlock, toBlock, direction, pageKey) {
  const configuredPageSize = Number(process.env.POOL_VOLUME_ASSET_TRANSFERS_PAGE_SIZE || 1000);
  if (!Number.isInteger(configuredPageSize) || configuredPageSize < 1 || configuredPageSize > 1000) {
    throw new Error('POOL_VOLUME_ASSET_TRANSFERS_PAGE_SIZE must be an integer between 1 and 1000');
  }
  const params = {
    fromBlock: asRpcHex(fromBlock),
    toBlock: asRpcHex(toBlock),
    category: ['erc20'],
    contractAddresses: [usdcAddr],
    withMetadata: false,
    excludeZeroValue: true,
    maxCount: asRpcHex(configuredPageSize),
  };

  if (direction === 'outgoing') {
    params.fromAddress = pairAddr;
  } else {
    params.toAddress = pairAddr;
  }

  if (pageKey) {
    params.pageKey = pageKey;
  }

  const result = await alchemyCall(chain, 'alchemy_getAssetTransfers', [params]);
  return {
    pageKey: result.pageKey || null,
    transfers: result.transfers,
  };
}

async function sumTokenTransfersViaAlchemyAssetTransfers(startBlock, endBlock, pairAddr, usdcAddr, chain, decimals = 6, onProgress) {
  const seen = new Map();
  let totalRaw = 0n;

  for (const direction of ['outgoing', 'incoming']) {
    let pageKey = null;
    const pageKeys = new Set();
    const directionEvents = new Set();

    while (true) {
      assertRunBudget();
      const page = await fetchPoolAssetTransfersPage(
        chain,
        usdcAddr,
        pairAddr,
        startBlock,
        endBlock,
        direction,
        pageKey,
      );

      for (const transfer of page.transfers) {
        const key = getAssetTransferKey(transfer);
        if (directionEvents.has(key)) throw invalidRpcResponse('Duplicate event across Asset Transfers pages');
        directionEvents.add(key);
        const fingerprint = transferFingerprint(transfer);
        if (seen.has(key)) {
          if (seen.get(key) !== fingerprint || transfer.from.toLowerCase() !== transfer.to.toLowerCase()) {
            throw invalidRpcResponse('Conflicting transfer identity between incoming and outgoing pages');
          }
          continue;
        }
        seen.set(key, fingerprint);
        totalRaw += getAssetTransferRawValue(transfer);
      }

      if (!page.pageKey) {
        break;
      }

      if (pageKeys.has(page.pageKey)) throw invalidRpcResponse('Repeated Asset Transfers pagination cursor');
      pageKeys.add(page.pageKey);
      pageKey = page.pageKey;
    }
  }

  // Asset Transfers paginates the whole range in memory, so it commits
  // atomically once the full range is summed: a mid-scan failure throws
  // before this call and commits nothing, leaving the eth_getLogs fallback a
  // clean range to rescan (no partial double-count).
  assertRunBudget();
  if (typeof onProgress === 'function') await onProgress(endBlock, totalRaw);

  return Number(totalRaw) / Math.pow(10, Number(decimals));
}

const DEFAULT_RPC_LOG_BLOCK_CHUNKS = {
  polygon: 3000,
  base: 5000,
};

function firstPositiveIntegerOr(values, fallback) {
  for (const value of values) {
    const parsed = Number(value);
    const integer = Math.floor(parsed);
    if (Number.isFinite(parsed) && integer > 0) return integer;
  }
  return fallback;
}

function getRpcLogChunkConfig(chain, env = process.env) {
  const normalizedChain = normalizeChain(chain);
  const chainSuffix = normalizedChain.toUpperCase();
  const defaultMaxChunk = DEFAULT_RPC_LOG_BLOCK_CHUNKS[normalizedChain] || 500;
  const configuredMaxChunk = Math.max(
    10,
    firstPositiveIntegerOr(
      [env[`RPC_LOG_BLOCK_CHUNK_${chainSuffix}`], env.RPC_LOG_BLOCK_CHUNK, env.LOG_CHUNK],
      defaultMaxChunk,
    ),
  );
  const configuredMinChunk = Math.max(
    1,
    Math.min(
      configuredMaxChunk,
      firstPositiveIntegerOr(
        [env[`RPC_MIN_LOG_BLOCK_CHUNK_${chainSuffix}`], env.RPC_MIN_LOG_BLOCK_CHUNK],
        10,
      ),
    ),
  );

  return { configuredMaxChunk, configuredMinChunk };
}

async function sumTokenTransfersViaRpc(startBlock, endBlock, pairAddr, usdcAddr, chain, decimals = 6, onProgress) {
  const { configuredMaxChunk, configuredMinChunk } = getRpcLogChunkConfig(chain);
  const pairTopic = addrToTopic(pairAddr);
  const seen = new Map();
  let totalRaw = 0n;
  let chunkSize = configuredMaxChunk;
  // Ceiling learned from a provider's "range too large" error (e.g. Alchemy
  // free tier = 10). Once known, the empty-window grow-back never exceeds it,
  // so we stop oscillating chunk-size against the same cap for the rest of the
  // scan — which keeps the fallback's request count bounded.
  let learnedMaxChunk = configuredMaxChunk;

  for (let from = startBlock; from <= endBlock;) {
    assertRunBudget();
    const to = Math.min(endBlock, from + chunkSize - 1);

    try {
      const beforeChunkRaw = totalRaw;
      const outgoing = await fetchTransferLogsRpc(chain, usdcAddr, from, to, pairTopic, false);
      const incoming = await fetchTransferLogsRpc(chain, usdcAddr, from, to, pairTopic, true);
      const merged = outgoing.concat(incoming);
      for (const log of merged) {
        const k = logKey(log);
        const fingerprint = logFingerprint(log);
        if (seen.has(k)) {
          if (seen.get(k) !== fingerprint || log.topics[1].toLowerCase() !== log.topics[2].toLowerCase()) {
            throw invalidRpcResponse('Conflicting transfer identity between incoming and outgoing logs');
          }
          continue;
        }
        seen.set(k, fingerprint);
        totalRaw += BigInt(log.data);
      }

      from = to + 1;

      // Commit this window (its volume delta + a checkpoint at `to`) before
      // advancing, so an interrupted scan of a large backlog keeps its
      // progress: the next run resumes from `to`+1 instead of rescanning
      // (double-count) or dropping the window. Chunks are disjoint block
      // ranges, so the per-chunk delta is exactly this window's contribution.
      assertRunBudget();
      if (typeof onProgress === 'function') await onProgress(to, totalRaw - beforeChunkRaw);

      const growCeiling = Math.min(configuredMaxChunk, learnedMaxChunk);
      if (merged.length === 0 && chunkSize < growCeiling) {
        chunkSize = Math.min(growCeiling, chunkSize * 2);
      }
    } catch (error) {
      if (error && ['POOL_STATE_PERSIST_FAILED', 'POOL_PROGRESS_FAILED', 'RPC_RUN_DEADLINE', 'RPC_INVALID_RESPONSE'].includes(error.code)) {
        throw error;
      }

      const inferredMaxChunk = inferMaxLogRangeFromError(error);
      const hasRangePressure = error.code === 'RPC_RANGE_LIMIT' ||
        (error.providerErrors || []).some((message) => /code=RPC_RANGE_(?:LIMIT|CEILING)\b/.test(message));
      if (inferredMaxChunk != null) {
        learnedMaxChunk = Math.min(learnedMaxChunk, inferredMaxChunk);
      }

      // A "range too large" error is recoverable by shrinking, even when the
      // aggregate also carries a rate-limited provider (Infura 429 riding
      // alongside Alchemy's 10-block 400): retrying the smaller span lets the
      // range-capped provider serve the scan. Only give up on a pure access
      // error, where no smaller chunk would help.
      if (inferredMaxChunk == null && !hasRangePressure && isProviderAccessError(error)) {
        throw new Error(
          `Failed eth_getLogs scan for ${chain} blocks ${from}-${to}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (inferredMaxChunk == null && !hasRangePressure) {
        throw new Error(`Failed eth_getLogs scan for ${chain} blocks ${from}-${to}: ${sanitizeRpcMessage(error)}`);
      }
      if (chunkSize <= configuredMinChunk) {
        throw new Error(
          `Failed eth_getLogs scan for ${chain} blocks ${from}-${to}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const nextChunkSize = inferredMaxChunk != null
        ? Math.max(configuredMinChunk, Math.min(chunkSize - 1, inferredMaxChunk))
        : Math.max(configuredMinChunk, Math.floor(chunkSize / 2));

      if (nextChunkSize === chunkSize) {
        throw new Error(
          `Failed eth_getLogs scan for ${chain} blocks ${from}-${to}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      console.warn(
        `[pool-volume] ${chain}: reducing log chunk ${chunkSize} -> ${nextChunkSize} after eth_getLogs error`,
      );
      chunkSize = nextChunkSize;
    }
  }

  return Number(totalRaw) / Math.pow(10, Number(decimals));
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function toEpochSeconds(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Convert millisecond timestamps if needed.
  if (n > 1e12) return Math.floor(n / 1000);
  return Math.floor(n);
}

function appendAlertReason(reason, makeAlert = false) {
  if (!reason) return;
  reason = sanitizeRpcMessage(reason);
  try {
    const a = readJson(ALERT_FILE, { alert: false, reasons: [] });
    a.alert = Boolean(a.alert || makeAlert);
    if (!Array.isArray(a.reasons)) a.reasons = [];
    if (!a.reasons.includes(reason)) a.reasons.push(reason);
    a.ts = new Date().toISOString();
    a.apiCallCount = apiCallCount;
    a.retryCount = retryCount;
    a.totalPoolCount = totalPoolCount;
    a.successfulPoolCount = successfulPoolCount;
    a.failedPoolCount = failedPoolCount;
    fs.writeFileSync(ALERT_FILE, JSON.stringify(a, null, 2));
  } catch (e) {
    console.warn('Unable to append alert reason', e && e.message);
  }
}

function isValidAddress(a) {
  if (!a || typeof a !== 'string') return false;
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

// The checkpoint must never move backward: `endBlock` is whichever provider
// answered eth_blockNumber THIS run, and load-balanced/failover providers can
// report a head lagging the provider that served the previous run. Regressing
// lastBlock would make the next run rescan blocks whose volume is already in
// total_usd — a silent, permanent double-count.
function clampCheckpointBlock(previousLastBlock, candidateBlock) {
  const prev = Number(previousLastBlock);
  if (!Number.isFinite(prev)) return candidateBlock;
  return Math.max(Math.floor(prev), candidateBlock);
}

// Drop checkpoint entries that no longer correspond to a tracked pool: legacy
// `<addr>-<chain>` keys whose suffix never matched the pool's chain, root-level
// scalar leftovers from old formats, and pools removed from the pool file.
function pruneCheckpoint(checkpoint, poolsMap) {
  const expectedKeys = new Set();
  for (const rawAddr of Object.keys(poolsMap)) {
    const addr = (rawAddr || '').toLowerCase();
    expectedKeys.add(addr);
    const chain = String((poolsMap[rawAddr] && poolsMap[rawAddr].chain) || '')
      .trim()
      .toLowerCase();
    if (chain) expectedKeys.add(`${addr}-${chain}`);
  }

  let pruned = 0;
  for (const key of Object.keys(checkpoint)) {
    if (!expectedKeys.has(String(key).toLowerCase())) {
      delete checkpoint[key];
      pruned += 1;
    }
  }
  return pruned;
}

// Write to a temp file then rename, so a process killed mid-write can't leave a
// truncated JSON file (readJson would fall back to {} and wipe the accumulated
// total_usd on the next run). This matters now that incremental checkpointing
// rewrites the pool file and checkpoint once per scanned window. POSIX rename is
// atomic-replace; the EEXIST/EPERM branch covers Windows (dev only — the updater
// runs on Linux CI), mirroring update_holder_rankings.js's writeJson.
function writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    if (!error || (error.code !== 'EEXIST' && error.code !== 'EPERM')) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // best-effort cleanup of the failed temp file
      }
      throw error;
    }
    fs.rmSync(filePath, { force: true });
    fs.renameSync(tmp, filePath);
  }
}

function selectAuthoritativeCheckpoint(poolState, legacyCheckpoint) {
  if (
    poolState &&
    typeof poolState === 'object' &&
    Object.prototype.hasOwnProperty.call(poolState, 'checkpoints')
  ) {
    return poolState.checkpoints &&
      typeof poolState.checkpoints === 'object' &&
      !Array.isArray(poolState.checkpoints)
      ? poolState.checkpoints
      : {};
  }
  return legacyCheckpoint &&
    typeof legacyCheckpoint === 'object' &&
    !Array.isArray(legacyCheckpoint)
    ? legacyCheckpoint
    : {};
}

function buildPoolState(poolsMap, checkpoint, lastUpdated = new Date().toISOString()) {
  return { pools: poolsMap, checkpoints: checkpoint, lastUpdated };
}

// `pool_volume.json` is the authoritative transaction: totals and their scan
// cursors are replaced in one atomic rename, so a process exit can expose
// neither a new total with an old cursor nor the reverse. The historical
// checkpoint file remains a derived compatibility/monitoring mirror only.
function persistPoolState(poolsMap, checkpoint) {
  writeFileAtomic(POOL_FILE, JSON.stringify(buildPoolState(poolsMap, checkpoint), null, 2));
  try {
    writeFileAtomic(CHECKPOINT, JSON.stringify(checkpoint, null, 2));
  } catch (error) {
    // The mirror must never make a successfully committed canonical state look
    // failed to the scanner, or the caller could retry an already-counted
    // window. A later run rebuilds the mirror from the embedded checkpoints.
    console.warn(
      `Unable to refresh checkpoint mirror after canonical commit: ${
        error && error.message ? error.message : String(error)
      }`,
    );
  }
}

function commitPoolProgress(
  poolsMap,
  checkpoint,
  { addr, legacyCheckpointKey, endTs, windowEndBlock, increment, totalUsd, finalizedAnchor, blockHash, preservePublished = false },
  persist = persistPoolState,
) {
  const hadPool = Object.prototype.hasOwnProperty.call(poolsMap, addr);
  const previousPool = hadPool ? { ...poolsMap[addr] } : undefined;
  const hadCheckpoint = Object.prototype.hasOwnProperty.call(checkpoint, addr);
  const previousCheckpoint = checkpoint[addr];
  const hadLegacyCheckpoint = Boolean(
    legacyCheckpointKey && Object.prototype.hasOwnProperty.call(checkpoint, legacyCheckpointKey),
  );
  const previousLegacyCheckpoint = legacyCheckpointKey ? checkpoint[legacyCheckpointKey] : undefined;

  const currentPool = poolsMap[addr] && typeof poolsMap[addr] === 'object' ? poolsMap[addr] : {};
  poolsMap[addr] = {
    ...currentPool,
    total_usd: preservePublished ? currentPool.total_usd : totalUsd === undefined ? Number(currentPool.total_usd || 0) + increment : totalUsd,
    lastUpdated: preservePublished ? currentPool.lastUpdated : new Date().toISOString(),
  };
  checkpoint[addr] = preservePublished
    ? { ...(previousCheckpoint || previousLegacyCheckpoint) }
    : { lastTimestamp: endTs, lastBlock: windowEndBlock };
  if (finalizedAnchor) checkpoint[addr].finalized = { ...finalizedAnchor };
  if (blockHash && !preservePublished) checkpoint[addr].blockHash = blockHash;
  if (legacyCheckpointKey) delete checkpoint[legacyCheckpointKey];

  try {
    persist(poolsMap, checkpoint);
  } catch (error) {
    if (hadPool) poolsMap[addr] = previousPool;
    else delete poolsMap[addr];
    if (hadCheckpoint) checkpoint[addr] = previousCheckpoint;
    else delete checkpoint[addr];
    if (legacyCheckpointKey) {
      if (hadLegacyCheckpoint) checkpoint[legacyCheckpointKey] = previousLegacyCheckpoint;
      else delete checkpoint[legacyCheckpointKey];
    }
    if (error && typeof error === 'object') error.code = 'POOL_STATE_PERSIST_FAILED';
    throw error;
  }
}

function legacyTotalToRaw(value, decimals) {
  const total = Number(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 ||
      !Number.isFinite(total) || total < 0 || total >= 1e21) {
    throw new Error('Invalid pool total or token decimals; refusing to reset accumulated volume');
  }
  return BigInt(total.toFixed(decimals).replace('.', ''));
}

async function scanPoolRange(startBlock, endBlock, pairAddr, usdcAddr, chain, decimals, onProgress) {
  try {
    await sumTokenTransfersViaAlchemyAssetTransfers(startBlock, endBlock, pairAddr, usdcAddr, chain, decimals, onProgress);
    return 'alchemy-asset-transfers';
  } catch (error) {
    if (['POOL_STATE_PERSIST_FAILED', 'POOL_PROGRESS_FAILED', 'RPC_RUN_DEADLINE'].includes(error && error.code)) throw error;
    console.warn(`[pool-volume] ${chain}: Asset Transfers failed; falling back to eth_getLogs: ${sanitizeRpcMessage(error)}`);
    await sumTokenTransfersViaRpc(startBlock, endBlock, pairAddr, usdcAddr, chain, decimals, onProgress);
    return 'rpc-logs-fallback';
  }
}

// The finalized anchor is trusted only after checking its block hash. Everything
// after it is provisional and replaced on the next run, including previously
// published transfers that were removed by a reorganization.
async function refreshPoolWithAnchor(options, dependencies = {}) {
  const { poolsMap, checkpoint, addr, legacyCheckpointKey, chain, pairAddr, usdcAddr, decimals, latest, finalized } = options;
  const getBlock = dependencies.getBlock || getBlockByNumberRpc;
  const scan = dependencies.scan || scanPoolRange;
  const persist = dependencies.persist || persistPoolState;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid pool token decimals');
  const existing = checkpoint[addr] || checkpoint[legacyCheckpointKey];
  const lastBlock = existing && existing.lastBlock;
  if (!Number.isSafeInteger(lastBlock) || lastBlock < 0) {
    throw new Error('Pool is missing a valid block checkpoint; operator recovery is required before scanning');
  }
  if (latest.number < lastBlock || finalized.number > latest.number) {
    throw new Error('RPC head is behind the saved checkpoint or finalized head; preserving existing pool state');
  }
  let anchor;
  let anchorBlock;
  if (Object.prototype.hasOwnProperty.call(existing, 'finalized')) {
    anchor = existing.finalized;
    if (!anchor || !Number.isSafeInteger(anchor.lastBlock) || anchor.lastBlock < 0 || anchor.lastBlock > lastBlock ||
        !HASH_PATTERN.test(anchor.blockHash) || typeof anchor.totalRaw !== 'string' || !/^\d+$/.test(anchor.totalRaw)) {
      throw new Error('Invalid finalized pool anchor; operator recovery is required');
    }
  } else {
    // A legacy total is accepted as a baseline, never reconstructed by scanning
    // old blocks. Its checkpoint must already be finalized before migration.
    if (lastBlock > finalized.number) {
      throw new Error('Legacy pool checkpoint is not finalized yet; preserving existing total until safe migration');
    }
    anchorBlock = await getBlock(chain, lastBlock);
    anchor = { lastBlock, blockHash: anchorBlock.hash, totalRaw: String(legacyTotalToRaw(poolsMap[addr].total_usd, decimals)) };
  }
  if (anchor.lastBlock > finalized.number) throw new Error('Finalized RPC head regressed behind the pool anchor');
  if (!anchorBlock) anchorBlock = await getBlock(chain, anchor.lastBlock);
  if (anchorBlock.number !== anchor.lastBlock || anchorBlock.hash.toLowerCase() !== anchor.blockHash.toLowerCase()) {
    throw new Error('Finalized pool anchor hash mismatch; preserving totals and requiring operator recovery');
  }
  anchor = { ...anchor, blockHash: anchor.blockHash.toLowerCase() };
  let canonicalRaw = BigInt(anchor.totalRaw);
  const previousTotal = poolsMap[addr].total_usd;
  const sources = new Set();
  const save = (endBlock, raw, block, finalizedAnchor, canonical = false) => commitPoolProgress(poolsMap, checkpoint, {
    addr, legacyCheckpointKey, endTs: block.timestamp, windowEndBlock: endBlock,
    totalUsd: Number(raw) / Math.pow(10, decimals), finalizedAnchor, blockHash: block.hash,
    preservePublished: canonical && endBlock < lastBlock,
  }, persist);

  if (anchor.lastBlock < finalized.number) {
    sources.add(await scan(anchor.lastBlock + 1, finalized.number, pairAddr, usdcAddr, chain, decimals, async (endBlock, deltaRaw) => {
      try {
        if (!Number.isSafeInteger(endBlock) || endBlock <= anchor.lastBlock || endBlock > finalized.number) {
          throw new Error('Finalized scan progress is outside the pinned canonical range');
        }
        // Re-read before every durable promotion, including intermediate log
        // windows. A finality violation during pagination must not attach newly
        // counted transfers to a stale, previously cached finalized hash.
        const block = await getBlock(chain, endBlock);
        const verifiedFinalized = endBlock === finalized.number ? block : await getBlock(chain, finalized.number);
        if (block.number !== endBlock || verifiedFinalized.number !== finalized.number ||
            verifiedFinalized.hash.toLowerCase() !== finalized.hash.toLowerCase()) {
          throw new Error('Finalized block changed during pool scan; canonical promotion refused');
        }
        const nextRaw = canonicalRaw + deltaRaw;
        const nextAnchor = { lastBlock: endBlock, blockHash: block.hash, totalRaw: String(nextRaw) };
        save(endBlock, nextRaw, block, nextAnchor, true);
        canonicalRaw = nextRaw;
        anchor = nextAnchor;
      } catch (error) {
        if (!['POOL_STATE_PERSIST_FAILED', 'RPC_RUN_DEADLINE'].includes(error.code)) error.code = 'POOL_PROGRESS_FAILED';
        throw error;
      }
    }));
  }

  let tentativeRaw = 0n;
  if (anchor.lastBlock < latest.number) {
    sources.add(await scan(anchor.lastBlock + 1, latest.number, pairAddr, usdcAddr, chain, decimals,
      async (_endBlock, deltaRaw) => { tentativeRaw += deltaRaw; }));
  }
  assertRunBudget();
  // Do not use a header cache here: a reorg during two-direction pagination
  // could otherwise publish transfers from different branches at one height.
  const verifiedLatest = await getBlock(chain, latest.number);
  if (verifiedLatest.number !== latest.number || verifiedLatest.hash.toLowerCase() !== latest.hash.toLowerCase()) {
    throw new Error('Latest block changed during pool scan; tentative transfers discarded, finalized progress preserved');
  }
  save(latest.number, canonicalRaw + tentativeRaw, latest, anchor);
  return { source: [...sources].join('+') || 'checkpoint-verified', totalUsdc: poolsMap[addr].total_usd - previousTotal };
}

async function main() {
  if (!ALCHEMY_API_KEY && !BACKUP_INFURA_API_KEY && !BACKUP_CHAINSTACK_BASE_RPC_URL) {
    throw new Error(
      'At least one RPC provider is required (ALCHEMY_API_KEY, BACKUP_INFURA_API_KEY, or BACKUP_CHAINSTACK_BASE_RPC_URL)',
    );
  }

  const budgetMs = Number(process.env.RPC_RUN_BUDGET_MS || 17 * 60 * 1000);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('RPC_RUN_BUDGET_MS must be positive');
  setRunDeadline(Date.now() + budgetMs);
  const now = Math.floor(Date.now() / 1000);
  const legacyCheckpoint = readJson(CHECKPOINT, {});
  let poolsRaw;
  try { poolsRaw = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')); }
  catch { throw new Error('Unable to read canonical pool state; refusing to reset accumulated totals'); }
  // Normalize pool file formats:
  // - legacy: object where keys are pool addresses
  // - modern: { pools: { <addr>: { ... } }, lastUpdated: ... }
  // - array: [{ address, usdc, chain, ... }]
  let poolsMap = {};
  if (poolsRaw && typeof poolsRaw === 'object') {
    if (poolsRaw.pools && typeof poolsRaw.pools === 'object') {
      poolsMap = poolsRaw.pools;
    } else if (Array.isArray(poolsRaw)) {
      for (const item of poolsRaw) {
        const a = (item.address || '').toLowerCase();
        if (a) poolsMap[a] = item;
      }
    } else {
      poolsMap = poolsRaw;
    }
  }
  if (!poolsMap || typeof poolsMap !== 'object' || Array.isArray(poolsMap) || Object.keys(poolsMap).length === 0) {
    throw new Error('Canonical pool state contains no tracked pools; refusing to overwrite it');
  }
  const checkpoint = selectAuthoritativeCheckpoint(poolsRaw, legacyCheckpoint);

  // initialize alert file
  try {
    fs.writeFileSync(
      ALERT_FILE,
      JSON.stringify(
        {
          alert: false,
          reasons: [],
          ts: new Date().toISOString(),
          apiCallCount: 0,
          retryCount: 0,
          totalPoolCount: 0,
          successfulPoolCount: 0,
          failedPoolCount: 0,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    console.warn('Unable to initialize alert file', e && e.message);
  }

  totalPoolCount = Object.keys(poolsMap).length;

  const prunedCheckpointKeys = pruneCheckpoint(checkpoint, poolsMap);
  if (prunedCheckpointKeys > 0) {
    console.log(`Pruned ${prunedCheckpointKeys} stale checkpoint entries`);
    persistPoolState(poolsMap, checkpoint);
  }

  for (const rawAddr of Object.keys(poolsMap)) {
    const addr = (rawAddr || '').toLowerCase();
    let chain = 'unknown';
    let startTs = null;
    try {
      // determine chain and addresses for this pool
      const pool = poolsMap[addr] || {};
      chain = normalizeChain(pool.chain);
      const usdcAddr = (pool.usdc || GLOBAL_USDC).toLowerCase();
      const pairAddr = (pool.address || addr || GLOBAL_PAIR).toLowerCase();
      const legacyCheckpointKey = `${addr}-${chain}`;
      const poolCheckpoint = checkpoint[addr] || checkpoint[legacyCheckpointKey] || {};
      const checkpointStartTs = toEpochSeconds(poolCheckpoint.lastTimestamp);
      const checkpointStartBlock = Number.isFinite(Number(poolCheckpoint.lastBlock))
        ? Math.floor(Number(poolCheckpoint.lastBlock))
        : null;
      const poolLastUpdatedTs = toEpochSeconds(pool.lastUpdated);
      startTs = checkpointStartTs || poolLastUpdatedTs || (now - Number(process.env.WINDOW_SECONDS || 3600));
      const endTs = Math.floor(Date.now() / 1000);

      console.log('Processing', addr, 'Start ts', startTs, 'end ts', endTs);

      // validate addresses before making API calls
      if (!isValidAddress(usdcAddr) || !isValidAddress(pairAddr)) {
        console.warn(`Skipping ${addr}: invalid address format (usdc=${usdcAddr}, pair=${pairAddr})`);
        appendAlertReason(`invalid-address: ${addr} usdc=${usdcAddr} pair=${pairAddr}`, true);
        failedPoolCount += 1;
        continue;
      }

      const finalized = await getFinalizedBlockState(chain);
      const latest = await getLatestBlockState(chain);
      const startBlock = checkpointStartBlock != null ? checkpointStartBlock + 1 : null;
      const endBlock = latest.number;
      const tokenDecimals = Number(pool.usdc_decimals ?? pool.decimals ?? process.env.USDC_DECIMALS ?? 6);
      const { source, totalUsdc: runTotalUsdc } = await refreshPoolWithAnchor({
        poolsMap, checkpoint, addr, legacyCheckpointKey, chain, pairAddr, usdcAddr,
        decimals: tokenDecimals, latest, finalized,
      });

      console.log(`Total USDC transfers for ${addr} (${source}):`, runTotalUsdc);

      // Append per-pool run summary (only on full completion; partial progress
      // was already persisted incrementally above).
      const runs = readJson(RUNS_FILE, []);
      runs.push({ pool: addr, startTs, endTs, startBlock, endBlock, totalUsdc: runTotalUsdc, source, ts: new Date().toISOString() });
      // ~100 entries (~2 days at hourly cadence) is plenty for the committed,
      // publicly served history; CI artifacts retain full runs for a week.
      fs.writeFileSync(RUNS_FILE, JSON.stringify(runs.slice(-100), null, 2));

      successfulPoolCount += 1;
    } catch (e) {
      failedPoolCount += 1;
      appendAlertReason(
        `pool-error: pool=${addr} chain=${chain} code=${(e && e.code) || 'unknown'} msg=${sanitizeRpcMessage(e)}`,
        false
      );
      console.error('Error processing', rawAddr, sanitizeRpcError(e));
      if (e && e.code === 'RPC_RUN_DEADLINE') throw e;
      // if retries were exhausted earlier, the alert file should already exist.
    }
  }

  // finalize alert file with final counters if no alert triggered
  try {
    const existing = readJson(ALERT_FILE, { alert: false, reasons: [] });
    if (!existing || !existing.alert) {
      fs.writeFileSync(
        ALERT_FILE,
        JSON.stringify(
          {
            alert: false,
            reasons: Array.isArray(existing.reasons) ? existing.reasons : [],
            ts: new Date().toISOString(),
            apiCallCount,
            retryCount,
            totalPoolCount,
            successfulPoolCount,
            failedPoolCount,
          },
          null,
          2
        )
      );
    }
  } catch (e) {
    console.warn('Unable to finalize alert file', e && e.message);
  }

  console.log('Done - wrote', POOL_FILE);
}

function flushRpcUsageTelemetry() {
  try {
    const usage = { ...rpcRunUsage.snapshot(), retryCount };
    writeRpcUsageComponent(
      RPC_USAGE_FILE,
      'poolVolume',
      getRpcUsageRunId(),
      usage,
      { reset: true },
    );
    console.log(`[rpc-usage] poolVolume ${JSON.stringify(usage)}`);
  } catch (error) {
    try {
      console.warn(
        `[rpc-usage] Unable to finalize poolVolume telemetry: ${
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
    .catch((e) => {
      console.error(sanitizeRpcError(e));
      process.exitCode = 1;
    })
    .finally(flushRpcUsageTelemetry);
}

// Exported for unit tests (see tests/poolVolume.test.ts). Importing this module
// does not run the updater; main() only runs when invoked directly.
module.exports = {
  classifyRpcErrorMessage,
  shouldDisableProviderForRun,
  normalizeChain,
  asRpcHex,
  fromRpcHex,
  addrToTopic,
  isValidAddress,
  toEpochSeconds,
  clampCheckpointBlock,
  pruneCheckpoint,
  getAssetTransferKey,
  getAssetTransferRawValue,
  computeRetryDelayMs,
  providerDisableKey,
  disableProviderForRun,
  getDisabledProviderInfo,
  getLogScanRpcUrlsForChain,
  getPublicRpcUrlsForChain,
  alchemyCall,
  sumTokenTransfersViaRpc,
  sumTokenTransfersViaAlchemyAssetTransfers,
  inferMaxLogRangeFromError,
  getLatestBlockNumberForRun,
  selectAuthoritativeCheckpoint,
  buildPoolState,
  commitPoolProgress,
  rpcCallWithUrls,
  providerRangeCeilings,
  getRpcLogChunkConfig,
  rpcRunUsage,
  providerCooldowns,
  validateRpcEnvelope,
  validateRpcMethodResult,
  refreshPoolWithAnchor,
  legacyTotalToRaw,
  setRunDeadline,
  assertRunBudget,
  requestWithRetries,
};
