// Indexer-based updater: sums USDC transfers to/from a pair address
// Uses blockchain indexer APIs (Etherscan/Polygonscan-compatible v2) to avoid heavy eth_getLogs
// Writes increments into public/data/pool_volume.json and updates a checkpoint.
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

// Use ETHERSCAN_API_KEY (required).
const API_KEY = process.env.ETHERSCAN_API_KEY;
// chain id defaults and utilities
const CHAIN_IDS = { ethereum: 1, polygon: 137, base: 8453 };
const DEFAULT_CHAIN = 'polygon';

const GLOBAL_USDC = (process.env.POLYGON_USDC || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174').toLowerCase();
const GLOBAL_PAIR = (process.env.PAIR_ADDRESS || '0xd093a031df30f186976a1e2936b16d95ca7919d6').toLowerCase();

const CHECKPOINT = path.join(__dirname, '..', 'public', 'data', 'pool_volume_checkpoint.json');
const POOL_FILE = path.join(__dirname, '..', 'public', 'data', 'pool_volume.json');
const RUNS_FILE = path.join(__dirname, '..', 'public', 'data', 'pool_volume_runs.json');
const ALERT_FILE = path.join(__dirname, '..', 'public', 'data', 'pool_volume_alert.json');

// global counters used by requestWithRetries and persisted to alert file
let apiCallCount = 0;
let retryCount = 0;

if (!API_KEY) {
  console.error('ETHERSCAN_API_KEY is required in environment');
  process.exit(2);
}

async function fetchJson(url) {
  const res = await requestWithRetries(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
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

async function getBlockByTimestamp(ts, chainid = CHAIN_IDS.polygon) {
  const base = `https://api.etherscan.io/v2/api?chainid=${chainid}`;
  const url = `${base}&module=block&action=getblocknobytime&timestamp=${ts}&closest=before&apikey=${API_KEY}`;
  const j = await fetchJson(url);
  if (j.status !== '1' && !j.result) {
    throw new Error('Failed to get block by time: ' + JSON.stringify(j));
  }
  return Number(j.result.blockNumber || j.result);
}

async function fetchTokenTxs(startBlock, endBlock, pairAddr, usdcAddr, chainid = CHAIN_IDS.polygon, page = 1, offset = 1000) {
  const base = `https://api.etherscan.io/v2/api?chainid=${chainid}`;
  const url = `${base}&module=account&action=tokentx&contractaddress=${usdcAddr}&address=${pairAddr}&startblock=${startBlock}&endblock=${endBlock}&page=${page}&offset=${offset}&sort=asc&apikey=${API_KEY}`;
  const j = await fetchJson(url);
  if (j.status === '0' && j.message === 'No transactions found') return [];
  if (j.status !== '1') throw new Error('tokentx error: ' + JSON.stringify(j));
  return j.result || [];
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
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
    fs.writeFileSync(ALERT_FILE, JSON.stringify({ alert: false, reasons: [], ts: new Date().toISOString(), apiCallCount: 0, retryCount: 0 }, null, 2));
  } catch (e) {
    console.warn('Unable to initialize alert file', e && e.message);
  }

  const MAX_JITTER = Number(process.env.MAX_JITTER || 300); // seconds (default 5 minutes)

  for (const rawAddr of Object.keys(poolsMap)) {
    const addr = (rawAddr || '').toLowerCase();
    try {
      // deterministic per-pool jitter to spread bursts
      const hash = addrHashToInt(addr);
      const jitter = hash % (MAX_JITTER + 1);
      if (jitter > 0) {
        console.log(`Sleeping ${jitter}s before processing ${addr}`);
        await sleepSeconds(jitter);
      }

      const poolCheckpoint = checkpoint[addr] || {};
      const startTs = poolCheckpoint.lastTimestamp || (now - Number(process.env.WINDOW_SECONDS || 3600));
      const endTs = Math.floor(Date.now() / 1000);

      console.log('Processing', addr, 'Start ts', startTs, 'end ts', endTs);

      // determine chain and addresses for this pool
      const pool = poolsMap[addr] || {};
      const chain = (pool.chain || DEFAULT_CHAIN).toLowerCase();
      const chainid = CHAIN_IDS[chain] || CHAIN_IDS[DEFAULT_CHAIN];
      const usdcAddr = (pool.usdc || GLOBAL_USDC).toLowerCase();
      const pairAddr = (pool.address || addr || GLOBAL_PAIR).toLowerCase();

      // validate addresses before making API calls
      if (!isValidAddress(usdcAddr) || !isValidAddress(pairAddr)) {
        console.warn(`Skipping ${addr}: invalid address format (usdc=${usdcAddr}, pair=${pairAddr})`);
        // write an alert entry for visibility
        try {
          const a = readJson(ALERT_FILE, { alert: false, reasons: [] });
          a.reasons = a.reasons || [];
          a.reasons.push(`invalid-address: ${addr} usdc=${usdcAddr} pair=${pairAddr}`);
          a.ts = new Date().toISOString();
          fs.writeFileSync(ALERT_FILE, JSON.stringify(a, null, 2));
        } catch { /* ignore */ }
        // save checkpoint to avoid reprocessing this bad entry repeatedly
        checkpoint[addr] = { lastTimestamp: endTs || now, lastBlock: null };
        fs.writeFileSync(CHECKPOINT, JSON.stringify(checkpoint, null, 2));
        continue;
      }

      const startBlock = await getBlockByTimestamp(startTs, chainid);
      const endBlock = await getBlockByTimestamp(endTs, chainid);
      console.log('Block range', startBlock, endBlock);

      // fetch token transfers and sum values
      let page = 1;
      let totalUsdc = 0;
      while (true) {
        const txs = await fetchTokenTxs(startBlock, endBlock, pairAddr, usdcAddr, chainid, page, 1000);
        if (!txs || txs.length === 0) break;
        for (const tx of txs) {
          const dec = Number(tx.tokenDecimal || 6);
          const val = Number(tx.value || '0') / Math.pow(10, dec);
          totalUsdc += val;
        }
        if (txs.length < 1000) break;
        page += 1;
      }

      console.log(`Total USDC transfers for ${addr}:`, totalUsdc);

      if (!poolsMap[addr]) {
        poolsMap[addr] = { address: addr, total_usd: 0, lastUpdated: null };
      }
      poolsMap[addr].total_usd = Number(poolsMap[addr].total_usd || 0) + totalUsdc;
      poolsMap[addr].lastUpdated = new Date().toISOString();

      // Append per-pool run summary
      const runs = readJson(RUNS_FILE, []);
      runs.push({ pool: addr, startTs, endTs, startBlock, endBlock, totalUsdc, ts: new Date().toISOString() });
      fs.writeFileSync(RUNS_FILE, JSON.stringify(runs.slice(-500), null, 2));

      // Save per-pool checkpoint
      checkpoint[addr] = { lastTimestamp: endTs, lastBlock: endBlock };

      // persist pool file after each pool to reduce lost work on failures
      fs.writeFileSync(POOL_FILE, JSON.stringify(poolsMap, null, 2));
      fs.writeFileSync(CHECKPOINT, JSON.stringify(checkpoint, null, 2));
    } catch (e) {
      console.error('Error processing', rawAddr, e);
      // if retries were exhausted earlier, the alert file should already exist.
    }
  }

  // finalize alert file with final counters if no alert triggered
  try {
    const existing = readJson(ALERT_FILE, { alert: false });
    if (!existing || !existing.alert) {
      fs.writeFileSync(ALERT_FILE, JSON.stringify({ alert: false, reasons: [], ts: new Date().toISOString(), apiCallCount, retryCount }, null, 2));
    }
  } catch (e) {
    console.warn('Unable to finalize alert file', e && e.message);
  }

  console.log('Done — wrote', POOL_FILE);
}

main().catch((e) => { console.error(e); process.exit(1); });
