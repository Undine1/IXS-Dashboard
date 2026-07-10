// Alchemy-backed updater: sums USDC transfers to/from a pair address
// using Alchemy Asset Transfers first, then RPC block lookups plus
// eth_getLogs as fallback (Infura, then Chainstack, then Alchemy as a
// last resort — Alchemy's enhanced APIs can be rate-limited while its
// core JSON-RPC still serves). Writes increments into
// public/data/pool_volume.json and updates a checkpoint.
const fs = require('fs');
const path = require('path');

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

// global counters used by requestWithRetries and persisted to alert file
let apiCallCount = 0;
let retryCount = 0;
let totalPoolCount = 0;
let successfulPoolCount = 0;
let failedPoolCount = 0;
const latestBlockCache = new Map();
const latestBlockNumberCache = new Map();
const disabledProviders = new Map();

if (!ALCHEMY_API_KEY && !BACKUP_INFURA_API_KEY && !BACKUP_CHAINSTACK_BASE_RPC_URL) {
  console.error(
    'At least one RPC provider is required (ALCHEMY_API_KEY, BACKUP_INFURA_API_KEY, or BACKUP_CHAINSTACK_BASE_RPC_URL)',
  );
  process.exit(2);
}

// Global request pacing: enforce a minimum gap between outbound RPC requests so
// the updater never bursts many calls in the same second. Alchemy's throughput
// (CUPS) ceiling is account-wide, so flattening this run's peak leaves headroom
// for other apps on the same key. Tune/disable via RPC_MIN_INTERVAL_MS.
let lastRpcRequestAt = 0;
async function paceRpcRequests() {
  const minIntervalMs = Number(process.env.RPC_MIN_INTERVAL_MS || 100);
  if (!(minIntervalMs > 0)) return;
  const waitMs = lastRpcRequestAt + minIntervalMs - Date.now();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  lastRpcRequestAt = Date.now();
}

// Equal jitter: half the exponential step is a guaranteed floor, the other
// half is randomized. Full jitter (random 0..exp) can roll near-zero waits
// that burn retry attempts inside the same provider throttle window.
function computeRetryDelayMs(attempt, baseDelayMs, maxDelayMs) {
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

async function requestWithRetries(url, opts = {}) {
  const maxAttempts = Number(process.env.API_MAX_ATTEMPTS || 5);
  const baseDelay = Number(process.env.API_BASE_DELAY_MS || 500); // ms
  const maxDelay = Number(process.env.API_MAX_DELAY_MS || 30000); // ms

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await paceRpcRequests();
      apiCallCount += 1;
      const res = await fetch(url, opts);

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
            responseText = (await res.text()).replace(/\s+/g, ' ').trim();
          } catch {
            responseText = '';
          }
          const err = new Error(
            `Request ${url} returned ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${
              responseText ? `: ${responseText}` : ''
            }; retries exhausted after ${maxAttempts} attempts`,
          );
          if (res.status === 401) err.code = 'RPC_UNAUTHORIZED';
          else if (res.status === 403) err.code = 'RPC_FORBIDDEN';
          else if (res.status === 429) err.code = 'RPC_RATE_LIMIT';
          else if (res.status === 408 || res.status === 504) err.code = 'RPC_TIMEOUT';
          else err.code = `RPC_HTTP_${res.status}`;
          err.status = res.status;
          err.url = url;
          err.suppressAlertFile = true;
          err.retryCountRecorded = true;
          throw err;
        }
        console.warn(`Request ${url} returned ${res.status}; attempt ${attempt}/${maxAttempts}, retrying after ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      return res;
    } catch (err) {
      if (!(err && err.retryCountRecorded)) {
        retryCount += 1;
      }
      if (attempt === maxAttempts) {
        if (err && err.suppressAlertFile) {
          throw err;
        }
        // write alert file before throwing so workflow can detect
        try {
          const a = { alert: true, reasons: [`request-failed: ${url}`, err && err.message], ts: new Date().toISOString(), apiCallCount, retryCount };
          fs.writeFileSync(ALERT_FILE, JSON.stringify(a, null, 2));
        } catch (e) {
          console.error('Failed to write alert file', e && e.message);
        }
        throw err;
      }
      const waitMs = computeRetryDelayMs(attempt, baseDelay, maxDelay);
      console.warn(`Request error for ${url}; attempt ${attempt}/${maxAttempts}, retrying after ${waitMs}ms`, err && err.message);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error('Unreachable: retries exhausted');
}

function classifyRpcErrorMessage(message) {
  const txt = String(message || '').toLowerCase();
  if (txt.includes('limit') || txt.includes('rate')) return 'RPC_RATE_LIMIT';
  if (txt.includes('timeout') || txt.includes('timed out')) return 'RPC_TIMEOUT';
  if (txt.includes('too many requests')) return 'RPC_RATE_LIMIT';
  return 'RPC_ERROR';
}

function shouldDisableProviderForRun(error) {
  const code = String((error && error.code) || '').toUpperCase();
  const status = Number((error && error.status) || Number.NaN);
  const message = String((error && error.message) || '').toLowerCase();
  if ([401, 403, 429].includes(status)) return true;
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
  for (const url of urls) {
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
      const payload = { jsonrpc: '2.0', id: Date.now(), method, params };
      const res = await requestWithRetries(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let responseText = '';
        try {
          responseText = (await res.text()).replace(/\s+/g, ' ').trim();
        } catch {
          responseText = '';
        }
        const err = new Error(
          `Alchemy HTTP ${res.status} ${res.statusText} at ${url}${responseText ? `: ${responseText}` : ''}`,
        );
        err.code = `ALCHEMY_HTTP_${res.status}`;
        throw err;
      }
      const j = await res.json();
      if (j && j.error) {
        const msg = j.error.message || JSON.stringify(j.error);
        const err = new Error(`Alchemy ${method} error at ${url}: ${msg}`);
        err.code = 'ALCHEMY_ERROR';
        throw err;
      }
      return j.result;
    } catch (e) {
      providerErrors.push(`${providerLabel}@${providerHost} code=${(e && e.code) || 'unknown'} msg=${(e && e.message) || String(e)}`);
      console.warn(`[pool-volume] ${chain} ${method}: provider ${providerLabel} (${providerHost}) failed: ${(e && e.message) || String(e)}`);
      disableProviderForRun(url, method, e);
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

async function getBlockByTimestamp(ts, chain) {
  return getBlockByTimestampRpc(ts, chain);
}

function asRpcHex(n) {
  return `0x${Math.max(0, Math.floor(Number(n) || 0)).toString(16)}`;
}

function fromRpcHex(value) {
  if (typeof value !== 'string' || !value.startsWith('0x')) return Number.NaN;
  try {
    return Number(BigInt(value));
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
  return `${(log && log.transactionHash) || ''}:${(log && log.logIndex) || ''}`;
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
  for (const url of urls) {
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
      const payload = { jsonrpc: '2.0', id: Date.now(), method, params };
      const res = await requestWithRetries(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let responseText = '';
        try {
          responseText = (await res.text()).replace(/\s+/g, ' ').trim();
        } catch {
          responseText = '';
        }
        const err = new Error(
          `RPC HTTP ${res.status} ${res.statusText} at ${url}${responseText ? `: ${responseText}` : ''}`,
        );
        if (res.status === 403) err.code = 'RPC_FORBIDDEN';
        else if (res.status === 429) err.code = 'RPC_RATE_LIMIT';
        else if (res.status === 408 || res.status === 504) err.code = 'RPC_TIMEOUT';
        else err.code = `RPC_HTTP_${res.status}`;
        throw err;
      }
      const j = await res.json();
      if (j && j.error) {
        const msg = j.error.message || JSON.stringify(j.error);
        const err = new Error(`RPC ${method} error at ${url}: ${msg}`);
        err.code = classifyRpcErrorMessage(msg);
        throw err;
      }
      if (providerErrors.length > 0) {
        console.warn(
          `[pool-volume] ${chain} ${method}: using fallback provider ${providerLabel} (${providerHost}) after previous failures: ${providerErrors.join(' | ')}`,
        );
      }
      return j.result;
    } catch (e) {
      const code = (e && e.code) || 'unknown';
      const message = (e && e.message) || String(e);
      providerErrors.push(`${providerLabel}@${providerHost} code=${code} msg=${message}`);
      console.warn(`[pool-volume] ${chain} ${method}: provider ${providerLabel} (${providerHost}) failed: ${message}`);
      disableProviderForRun(url, method, e);
      lastErr = e;
      continue;
    }
  }

  const aggregate = new Error(
    `RPC call failed for chain=${chain} method=${method}; providers tried: ${providerErrors.join(' | ')}`,
  );
  aggregate.code = (lastErr && lastErr.code) || 'RPC_ALL_PROVIDERS_FAILED';
  aggregate.providerErrors = providerErrors;
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
  return { number: num, timestamp: ts };
}

async function getBlockByTimestampRpc(ts, chain) {
  const targetTs = Number(ts);
  if (!Number.isFinite(targetTs) || targetTs < 0) {
    const err = new Error(`Invalid timestamp for RPC block lookup: ${ts}`);
    err.code = 'RPC_INVALID_TIMESTAMP';
    throw err;
  }
  const latest = await getLatestBlockState(chain);
  if (targetTs >= latest.timestamp) return latest.number;

  let low = 0;
  let high = latest.number;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const b = await getBlockByNumberRpc(chain, mid);
    if (b.timestamp <= targetTs) {
      best = b.number;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

// Free-tier eth_getLogs providers cap the block span per request (Alchemy's
// free plan is 10 blocks) and report the ceiling in the error body, e.g.
// "you can make eth_getLogs requests with up to a 10 block range. Based on
// your parameters, this block range should work: [0x.., 0x..]". Parse that
// ceiling so the scan can drop straight to a compliant chunk instead of
// blindly halving. Returns null when no range hint is present.
function inferMaxLogRangeFromError(error) {
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
  return Array.isArray(logs) ? logs : [];
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
  if (txHash) return `${txHash}:${logIndex}`;

  return JSON.stringify({
    blockNum: transfer && transfer.blockNum,
    from: transfer && transfer.from,
    to: transfer && transfer.to,
    value: transfer && transfer.rawContract && transfer.rawContract.value,
  });
}

function getAssetTransferRawValue(transfer) {
  try {
    return BigInt(
      (transfer && transfer.rawContract && transfer.rawContract.value) || '0x0',
    );
  } catch {
    return 0n;
  }
}

async function fetchPoolAssetTransfersPage(chain, usdcAddr, pairAddr, fromBlock, toBlock, direction, pageKey) {
  const params = {
    fromBlock: asRpcHex(fromBlock),
    toBlock: asRpcHex(toBlock),
    category: ['erc20'],
    contractAddresses: [usdcAddr],
    withMetadata: false,
    excludeZeroValue: true,
    maxCount: asRpcHex(Math.max(1, Number(process.env.POOL_VOLUME_ASSET_TRANSFERS_PAGE_SIZE || 1000))),
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
    pageKey: result && typeof result.pageKey === 'string' ? result.pageKey : null,
    transfers: Array.isArray(result && result.transfers) ? result.transfers : [],
  };
}

async function sumTokenTransfersViaAlchemyAssetTransfers(startBlock, endBlock, pairAddr, usdcAddr, chain, decimals = 6, onProgress) {
  const seen = new Set();
  let totalRaw = 0n;

  for (const direction of ['outgoing', 'incoming']) {
    let pageKey = null;

    while (true) {
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
        if (seen.has(key)) continue;
        seen.add(key);
        totalRaw += getAssetTransferRawValue(transfer);
      }

      if (!page.pageKey) {
        break;
      }

      pageKey = page.pageKey;
    }
  }

  // Asset Transfers paginates the whole range in memory, so it commits
  // atomically once the full range is summed: a mid-scan failure throws
  // before this call and commits nothing, leaving the eth_getLogs fallback a
  // clean range to rescan (no partial double-count).
  if (typeof onProgress === 'function') onProgress(endBlock, totalRaw);

  return Number(totalRaw) / Math.pow(10, Number(decimals) || 6);
}

async function sumTokenTransfersViaRpc(startBlock, endBlock, pairAddr, usdcAddr, chain, decimals = 6, onProgress) {
  const configuredMaxChunk = Math.max(
    10,
    Number(process.env.RPC_LOG_BLOCK_CHUNK || process.env.LOG_CHUNK || 500),
  );
  const configuredMinChunk = Math.max(
    1,
    Math.min(configuredMaxChunk, Number(process.env.RPC_MIN_LOG_BLOCK_CHUNK || 10)),
  );
  const pairTopic = addrToTopic(pairAddr);
  const seen = new Set();
  let totalRaw = 0n;
  let chunkSize = configuredMaxChunk;
  // Ceiling learned from a provider's "range too large" error (e.g. Alchemy
  // free tier = 10). Once known, the empty-window grow-back never exceeds it,
  // so we stop oscillating chunk-size against the same cap for the rest of the
  // scan — which keeps the fallback's request count bounded.
  let learnedMaxChunk = configuredMaxChunk;

  for (let from = startBlock; from <= endBlock;) {
    const to = Math.min(endBlock, from + chunkSize - 1);

    try {
      const beforeChunkRaw = totalRaw;
      const outgoing = await fetchTransferLogsRpc(chain, usdcAddr, from, to, pairTopic, false);
      const incoming = await fetchTransferLogsRpc(chain, usdcAddr, from, to, pairTopic, true);
      const merged = outgoing.concat(incoming);
      for (const log of merged) {
        const k = logKey(log);
        if (seen.has(k)) continue;
        seen.add(k);
        try {
          totalRaw += BigInt(log.data || '0x0');
        } catch {
          // ignore malformed log payload
        }
      }

      from = to + 1;

      // Commit this window (its volume delta + a checkpoint at `to`) before
      // advancing, so an interrupted scan of a large backlog keeps its
      // progress: the next run resumes from `to`+1 instead of rescanning
      // (double-count) or dropping the window. Chunks are disjoint block
      // ranges, so the per-chunk delta is exactly this window's contribution.
      if (typeof onProgress === 'function') onProgress(to, totalRaw - beforeChunkRaw);

      const growCeiling = Math.min(configuredMaxChunk, learnedMaxChunk);
      if (merged.length === 0 && chunkSize < growCeiling) {
        chunkSize = Math.min(growCeiling, chunkSize * 2);
      }
    } catch (error) {
      if (error && error.code === 'POOL_STATE_PERSIST_FAILED') {
        throw error;
      }

      const inferredMaxChunk = inferMaxLogRangeFromError(error);
      if (inferredMaxChunk != null) {
        learnedMaxChunk = Math.min(learnedMaxChunk, inferredMaxChunk);
      }

      // A "range too large" error is recoverable by shrinking, even when the
      // aggregate also carries a rate-limited provider (Infura 429 riding
      // alongside Alchemy's 10-block 400): retrying the smaller span lets the
      // range-capped provider serve the scan. Only give up on a pure access
      // error, where no smaller chunk would help.
      if (inferredMaxChunk == null && isProviderAccessError(error)) {
        throw new Error(
          `Failed eth_getLogs scan for ${chain} blocks ${from}-${to}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
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

  return Number(totalRaw) / Math.pow(10, Number(decimals) || 6);
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
  { addr, legacyCheckpointKey, endTs, windowEndBlock, increment },
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
    total_usd: Number(currentPool.total_usd || 0) + increment,
    lastUpdated: new Date().toISOString(),
  };
  checkpoint[addr] = { lastTimestamp: endTs, lastBlock: windowEndBlock };
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

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const legacyCheckpoint = readJson(CHECKPOINT, {});
  const poolsRaw = readJson(POOL_FILE, {});
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

      if (startTs >= endTs) {
        console.log(`Skipping ${addr}: checkpoint start (${startTs}) is not before end (${endTs})`);
        checkpoint[addr] = { lastTimestamp: endTs, lastBlock: poolCheckpoint.lastBlock || null };
        if (checkpoint[legacyCheckpointKey]) delete checkpoint[legacyCheckpointKey];
        persistPoolState(poolsMap, checkpoint);
        successfulPoolCount += 1;
        continue;
      }

      console.log('Processing', addr, 'Start ts', startTs, 'end ts', endTs);

      // validate addresses before making API calls
      if (!isValidAddress(usdcAddr) || !isValidAddress(pairAddr)) {
        console.warn(`Skipping ${addr}: invalid address format (usdc=${usdcAddr}, pair=${pairAddr})`);
        appendAlertReason(`invalid-address: ${addr} usdc=${usdcAddr} pair=${pairAddr}`, true);
        // save checkpoint to avoid reprocessing this bad entry repeatedly
        checkpoint[addr] = { lastTimestamp: endTs || now, lastBlock: null };
        if (checkpoint[legacyCheckpointKey]) delete checkpoint[legacyCheckpointKey];
        persistPoolState(poolsMap, checkpoint);
        failedPoolCount += 1;
        continue;
      }

      let startBlock;
      let endBlock;
      let source = 'alchemy-asset-transfers';
      startBlock = checkpointStartBlock != null ? checkpointStartBlock + 1 : await getBlockByTimestamp(startTs, chain);
      // This index is cumulative and resumes from a concrete block checkpoint,
      // so the current head number is the exact end cursor we need. Resolving
      // the current wall-clock timestamp back to a block fetched that same head
      // and then fetched the full block solely to rediscover its number.
      endBlock = await getLatestBlockNumberForRun(chain);
      if (!Number.isFinite(startBlock) || !Number.isFinite(endBlock)) {
        const err = new Error(`Invalid block range resolved: start=${startBlock}, end=${endBlock}`);
        err.code = 'INVALID_BLOCK_RANGE';
        throw err;
      }
      if (startBlock > endBlock) {
        console.log(`Skipping ${addr}: no new blocks since checkpoint (start=${startBlock}, end=${endBlock})`);
        checkpoint[addr] = {
          lastTimestamp: endTs,
          lastBlock: clampCheckpointBlock(checkpointStartBlock, endBlock),
        };
        if (checkpoint[legacyCheckpointKey]) delete checkpoint[legacyCheckpointKey];
        persistPoolState(poolsMap, checkpoint);
        successfulPoolCount += 1;
        continue;
      }
      console.log('Block range', startBlock, endBlock);
      const tokenDecimals = Number(pool.usdc_decimals || pool.decimals || process.env.USDC_DECIMALS || 6);

      if (!poolsMap[addr]) {
        poolsMap[addr] = { address: addr, total_usd: 0, lastUpdated: null };
      }

      // Commit each scanned window incrementally: add its volume delta AND
      // advance the checkpoint to its last block in one authoritative file, so a
      // scan interrupted partway through a large backlog (e.g. the free-tier
      // eth_getLogs fallback rate-limiting mid-run) keeps its progress. The
      // next run resumes from lastBlock+1, so no window is rescanned (which
      // would double-count) or lost. Volume and checkpoint move together, so a
      // crash between windows can only lose the *uncommitted* tail, which the
      // next run re-scans cleanly.
      let runTotalUsdc = 0;
      const commitProgress = (windowEndBlock, windowRaw) => {
        const increment = Number(windowRaw) / Math.pow(10, tokenDecimals);
        commitPoolProgress(
          poolsMap,
          checkpoint,
          { addr, legacyCheckpointKey, endTs, windowEndBlock, increment },
        );
        runTotalUsdc += increment;
      };

      try {
        await sumTokenTransfersViaAlchemyAssetTransfers(
          startBlock,
          endBlock,
          pairAddr,
          usdcAddr,
          chain,
          tokenDecimals,
          commitProgress,
        );
      } catch (error) {
        if (error && error.code === 'POOL_STATE_PERSIST_FAILED') {
          throw error;
        }
        console.warn(
          `[pool-volume] ${chain}: alchemy_getAssetTransfers failed, falling back to eth_getLogs: ${
            error && error.message ? error.message : String(error)
          }`,
        );
        source = 'infura-rpc-logs-fallback';
        await sumTokenTransfersViaRpc(startBlock, endBlock, pairAddr, usdcAddr, chain, tokenDecimals, commitProgress);
      }

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
        `pool-error: pool=${addr} chain=${chain} code=${(e && e.code) || 'unknown'} msg=${(e && e.message) || String(e)}`,
        false
      );
      console.error('Error processing', rawAddr, e);
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

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
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
};
