// Alchemy-backed updater: sums USDC transfers to/from a pair address
// using RPC block lookups plus eth_getLogs. Writes increments into
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
const BACKUP_API_KEY = String(process.env.BACKUP_API_KEY || '').trim();
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

if (!ALCHEMY_API_KEY && !BACKUP_API_KEY) {
  console.error('At least one RPC API key is required (ALCHEMY_API_KEY or BACKUP_API_KEY)');
  process.exit(2);
}

async function requestWithRetries(url, opts = {}) {
  const maxAttempts = Number(process.env.API_MAX_ATTEMPTS || 5);
  const baseDelay = Number(process.env.API_BASE_DELAY_MS || 500); // ms
  const maxDelay = Number(process.env.API_MAX_DELAY_MS || 30000); // ms

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
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
          const exp = Math.min(maxDelay, baseDelay * Math.pow(2, attempt - 1));
          // full jitter up to exp
          waitMs = Math.floor(Math.random() * exp);
        }
        retryCount += 1;
        console.warn(`Request ${url} returned ${res.status}; attempt ${attempt}/${maxAttempts}, retrying after ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      return res;
    } catch (err) {
      retryCount += 1;
      if (attempt === maxAttempts) {
        // write alert file before throwing so workflow can detect
        try {
          const a = { alert: true, reasons: [`request-failed: ${url}`, err && err.message], ts: new Date().toISOString(), apiCallCount, retryCount };
          fs.writeFileSync(ALERT_FILE, JSON.stringify(a, null, 2));
        } catch (e) {
          console.error('Failed to write alert file', e && e.message);
        }
        throw err;
      }
      const exp = Math.min(maxDelay, baseDelay * Math.pow(2, attempt - 1));
      const waitMs = Math.floor(Math.random() * exp);
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
  if (!network || !BACKUP_API_KEY) return [];
  return [`https://${network}.infura.io/v3/${BACKUP_API_KEY}`];
}

function getRpcUrlsForChain(chain) {
  return [...getAlchemyRpcUrlsForChain(chain), ...getInfuraRpcUrlsForChain(chain)];
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
  return host || 'unknown';
}

async function rpcCall(chain, method, params) {
  const urls = getRpcUrlsForChain(chain);
  if (!urls.length) {
    const err = new Error(`No RPC URL configured for chain=${chain}`);
    err.code = 'RPC_MISSING_URL';
    throw err;
  }

  let lastErr = null;
  const providerErrors = [];
  for (const url of urls) {
    const providerLabel = getProviderLabel(url);
    const providerHost = getProviderHost(url);
    try {
      const payload = { jsonrpc: '2.0', id: Date.now(), method, params };
      const res = await requestWithRetries(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = new Error(`RPC HTTP ${res.status} ${res.statusText} at ${url}`);
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
  const latestNum = await getLatestBlockRpc(chain);
  const latest = await getBlockByNumberRpc(chain, latestNum);
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
  const logs = await rpcCall(chain, 'eth_getLogs', params);
  return Array.isArray(logs) ? logs : [];
}

async function sumTokenTransfersViaRpc(startBlock, endBlock, pairAddr, usdcAddr, chain, decimals = 6) {
  const chunkSize = Math.max(10, Number(process.env.RPC_LOG_BLOCK_CHUNK || 500));
  const pairTopic = addrToTopic(pairAddr);
  const seen = new Set();
  let totalRaw = 0n;

  for (let from = startBlock; from <= endBlock; from += chunkSize) {
    const to = Math.min(endBlock, from + chunkSize - 1);
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

function addrHashToInt(a) {
  let h = 0;
  for (let i = 0; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) >>> 0;
  return h;
}

function isValidAddress(a) {
  if (!a || typeof a !== 'string') return false;
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

async function sleepSeconds(s) {
  return new Promise((res) => setTimeout(res, s * 1000));
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const checkpoint = readJson(CHECKPOINT, {});
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

  const MAX_JITTER = Number(process.env.MAX_JITTER || 300); // seconds (default 5 minutes)
  totalPoolCount = Object.keys(poolsMap).length;

  for (const rawAddr of Object.keys(poolsMap)) {
    const addr = (rawAddr || '').toLowerCase();
    let chain = 'unknown';
    let startTs = null;
    try {
      // deterministic per-pool jitter to spread bursts
      const hash = addrHashToInt(addr);
      const jitter = hash % (MAX_JITTER + 1);
      if (jitter > 0) {
        console.log(`Sleeping ${jitter}s before processing ${addr}`);
        await sleepSeconds(jitter);
      }

      // determine chain and addresses for this pool
      const pool = poolsMap[addr] || {};
      chain = normalizeChain(pool.chain);
      const usdcAddr = (pool.usdc || GLOBAL_USDC).toLowerCase();
      const pairAddr = (pool.address || addr || GLOBAL_PAIR).toLowerCase();
      const legacyCheckpointKey = `${addr}-${chain}`;
      const poolCheckpoint = checkpoint[addr] || checkpoint[legacyCheckpointKey] || {};
      const checkpointStartTs = toEpochSeconds(poolCheckpoint.lastTimestamp);
      const poolLastUpdatedTs = toEpochSeconds(pool.lastUpdated);
      startTs = checkpointStartTs || poolLastUpdatedTs || (now - Number(process.env.WINDOW_SECONDS || 3600));
      const endTs = Math.floor(Date.now() / 1000);

      if (startTs >= endTs) {
        console.log(`Skipping ${addr}: checkpoint start (${startTs}) is not before end (${endTs})`);
        checkpoint[addr] = { lastTimestamp: endTs, lastBlock: poolCheckpoint.lastBlock || null };
        if (checkpoint[legacyCheckpointKey]) delete checkpoint[legacyCheckpointKey];
        fs.writeFileSync(CHECKPOINT, JSON.stringify(checkpoint, null, 2));
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
        fs.writeFileSync(CHECKPOINT, JSON.stringify(checkpoint, null, 2));
        failedPoolCount += 1;
        continue;
      }

      let startBlock;
      let endBlock;
      let totalUsdc = 0;
      const source = 'alchemy-rpc';
      startBlock = await getBlockByTimestamp(startTs, chain);
      endBlock = await getBlockByTimestamp(endTs, chain);
      if (!Number.isFinite(startBlock) || !Number.isFinite(endBlock) || endBlock < startBlock) {
        const err = new Error(`Invalid block range resolved: start=${startBlock}, end=${endBlock}`);
        err.code = 'INVALID_BLOCK_RANGE';
        throw err;
      }
      console.log('Block range', startBlock, endBlock);
      const tokenDecimals = Number(pool.usdc_decimals || pool.decimals || process.env.USDC_DECIMALS || 6);
      totalUsdc = await sumTokenTransfersViaRpc(startBlock, endBlock, pairAddr, usdcAddr, chain, tokenDecimals);

      console.log(`Total USDC transfers for ${addr} (${source}):`, totalUsdc);

      if (!poolsMap[addr]) {
        poolsMap[addr] = { address: addr, total_usd: 0, lastUpdated: null };
      }
      poolsMap[addr].total_usd = Number(poolsMap[addr].total_usd || 0) + totalUsdc;
      poolsMap[addr].lastUpdated = new Date().toISOString();

      // Append per-pool run summary
      const runs = readJson(RUNS_FILE, []);
      runs.push({ pool: addr, startTs, endTs, startBlock, endBlock, totalUsdc, source, ts: new Date().toISOString() });
      fs.writeFileSync(RUNS_FILE, JSON.stringify(runs.slice(-500), null, 2));

      // Save per-pool checkpoint
      checkpoint[addr] = { lastTimestamp: endTs, lastBlock: endBlock };
      if (checkpoint[legacyCheckpointKey]) delete checkpoint[legacyCheckpointKey];

      // persist pool file after each pool to reduce lost work on failures
      fs.writeFileSync(POOL_FILE, JSON.stringify(poolsMap, null, 2));
      fs.writeFileSync(CHECKPOINT, JSON.stringify(checkpoint, null, 2));
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

main().catch((e) => { console.error(e); process.exit(1); });
