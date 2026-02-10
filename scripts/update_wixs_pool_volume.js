#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

// Load .env.local into process.env if present (simple parser)
try {
  const envFile = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.trim().startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const key = line.substring(0, idx).trim();
      const val = line.substring(idx + 1);
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  }
} catch (e) {
  // ignore
}

// Configuration
const DEFAULT_POOLS = [
  '0xd093a031df30f186976a1e2936b16d95ca7919d6'
].map(p => p.toLowerCase());
const POOLS = (process.env.POOLS || DEFAULT_POOLS.join(',')).split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
const RPC = process.env.ALCHEMY_POLYGON || process.env.POLYGON_RPC || 'https://rpc.ankr.com/polygon';
const DATA_FILE = path.join(__dirname, '..', 'public', 'data', 'pool_volume.json');
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Only track USDC on Polygon (1 USDC = $1)
const USDC = (process.env.POLYGON_USDC || '0x2791bca1f2de4661ed88a30c99a7a9449aa84174').toLowerCase();
const USDC_DECIMALS = 6;

const BLOCKS_PER_DAY = Number(process.env.BLOCKS_PER_DAY || 6000);
const REQUEST_MIN_INTERVAL_MS = Number(process.env.REQUEST_MIN_INTERVAL_MS || 1000);

async function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { pools: {}, lastUpdated: 0 };
  }
}

async function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

async function findBlockByTimestamp(provider, targetTs, latestBlock) {
  // Binary search for the lowest block where block.timestamp >= targetTs
  let low = 0;
  let high = latestBlock;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const b = await providerGetBlock(provider, mid);
    if (!b) { low = mid + 1; continue; }
    const ts = Number(b.timestamp);
    if (ts < targetTs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function providerGetBlock(provider, blockNumber) {
  const maxRetries = 6;
  let attempt = 0;
  while (true) {
    try {
      const res = await provider.getBlock(blockNumber);
      await sleep(REQUEST_MIN_INTERVAL_MS + Math.floor(Math.random() * 200));
      return res;
    } catch (e) {
      attempt++;
      if (attempt > maxRetries) throw e;
      const wait = Math.min(30000, 1000 * Math.pow(2, attempt));
      console.warn(`getBlock failed (attempt ${attempt}), retrying in ${wait}ms:`, e.message || e);
      await sleep(wait + Math.floor(Math.random() * 200));
    }
  }
}

async function providerGetBlockNumber(provider) {
  const maxRetries = 4;
  let attempt = 0;
  while (true) {
    try {
      const n = await provider.getBlockNumber();
      await sleep(REQUEST_MIN_INTERVAL_MS + Math.floor(Math.random() * 200));
      return n;
    } catch (e) {
      attempt++;
      if (attempt > maxRetries) throw e;
      const wait = 1000 * Math.pow(2, attempt);
      console.warn(`getBlockNumber failed (attempt ${attempt}), retrying in ${wait}ms:`, e.message || e);
      await sleep(wait);
    }
  }
}

async function providerGetLogs(provider, filter) {
  const maxRetries = 6;
  let attempt = 0;
  while (true) {
    try {
      const r = await provider.getLogs(filter);
      await sleep(REQUEST_MIN_INTERVAL_MS + Math.floor(Math.random() * 200));
      return r;
    } catch (e) {
      attempt++;
      // If provider is returning internal errors, try polygonscan fallback (if API key present)
      const msg = String(e && (e.message || e));
      const isInternal = (e && (e.code === -32000 || /Internal error|-32000|could not coalesce error/.test(msg)));
      if (isInternal && process.env.ETHERSCAN_API_KEY) {
        try {
          const fallback = await polygonscanGetLogs(filter);
          // polygonscan may return [] (no logs) which is a valid result — return it.
          return fallback || [];
        } catch (pf) {
          console.warn('polygonscan fallback failed:', pf.message || pf);
        }
      }
      if (attempt > maxRetries) throw e;
      const wait = Math.min(30000, 1000 * Math.pow(2, attempt));
      console.warn(`getLogs failed (attempt ${attempt}), retrying in ${wait}ms:`, e.message || e);
      await sleep(wait + Math.floor(Math.random() * 200));
    }
  }
}

async function polygonscanGetLogs(filter) {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new Error('ETHERSCAN_API_KEY not set');
  const base = 'https://api.polygonscan.com/api';
  const params = new URLSearchParams({
    module: 'logs',
    action: 'getLogs',
    fromBlock: String(filter.fromBlock),
    toBlock: String(filter.toBlock),
    address: filter.address,
    topic0: (filter.topics && filter.topics[0]) || '',
    apikey: key,
  });
  const url = `${base}?${params.toString()}`;
  const res = await fetch(url, { method: 'GET' });
  const json = await res.json();
  if (!json) throw new Error('empty polygonscan response');
  if (json.status === '0' && json.message && json.result) {
    // no logs
    return [];
  }
  if (json.status !== '1' || !Array.isArray(json.result)) {
    throw new Error(`polygonscan error: ${json.message || JSON.stringify(json)}`);
  }
  // convert to ethers-like log objects
  return json.result.map((lg) => ({
    ...lg,
    blockNumber: Number(lg.blockNumber),
    topics: Array.isArray(lg.topics) ? lg.topics : (lg.topics ? JSON.parse(lg.topics) : []),
  }));
}

async function fetchLogs(provider, fromBlock, toBlock, poolTopicEncoded, topicIndex) {
  // topicIndex: 1 for from (topic1), 2 for to (topic2)
  const topics = [];
  topics[0] = TRANSFER_TOPIC;
  topics[1] = null; topics[2] = null;
  if (topicIndex === 1) topics[1] = poolTopicEncoded;
  if (topicIndex === 2) topics[2] = poolTopicEncoded;
  const filter = { address: USDC, fromBlock, toBlock, topics };
  // Chunk large ranges to avoid provider "block range is too large" errors.
  // Enforce a hard provider-specific cap to avoid Alchemy free-tier failures.
  const MAX_LOG_BLOCK_RANGE = Number(process.env.MAX_LOG_BLOCK_RANGE || 5);
  let CHUNK = Number(process.env.LOG_CHUNK || 1000);
  if (CHUNK > MAX_LOG_BLOCK_RANGE) {
    console.warn(`Capping CHUNK ${CHUNK} to MAX_LOG_BLOCK_RANGE ${MAX_LOG_BLOCK_RANGE}`);
    CHUNK = MAX_LOG_BLOCK_RANGE;
  }
  const results = [];
  for (let start = Number(fromBlock); start <= Number(toBlock); start += CHUNK) {
    const end = Math.min(Number(toBlock), start + CHUNK - 1);
    const chunkFilter = { address: USDC, fromBlock: start, toBlock: end, topics };
    try {
      // If forced to use Polygonscan for stability/testing, call the fallback directly
      if (process.env.FORCE_POLYGONSCAN === '1' || process.env.FORCE_POLYGONSCAN === 'true') {
        console.log(`FORCE_POLYGONSCAN active: polygonscan chunk ${start}-${end}`);
        const part = await polygonscanGetLogs(chunkFilter);
        if (part && part.length) results.push(...part);
        // small sleep to respect polygonscan rate limits
        await sleep(500 + Math.floor(Math.random() * 500));
        continue;
      }
      console.log(`getLogs chunk ${start}-${end}`);
      const part = await providerGetLogs(provider, chunkFilter);
      if (part && part.length) results.push(...part);
      // pacing between provider calls to avoid bursts
      await sleep(REQUEST_MIN_INTERVAL_MS + Math.floor(Math.random() * 200));
    } catch (err) {
      console.warn(`fetchLogs chunk failed ${start}-${end}, retrying with smaller sub-chunks:`, err && err.message ? err.message : String(err));
      // Try splitting the chunk into smaller sub-chunks to satisfy strict providers
      // Ensure SUB is at least 1 and not larger than CHUNK
      const SUB = Math.max(1, Math.min(CHUNK, Math.floor(Math.max(1, CHUNK) / 2)));
      for (let s = start; s <= end; s += SUB) {
        const e = Math.min(end, s + SUB - 1);
        const subFilter = { address: USDC, fromBlock: s, toBlock: e, topics };
        try {
          if (process.env.FORCE_POLYGONSCAN === '1' || process.env.FORCE_POLYGONSCAN === 'true') {
            console.log(`FORCE_POLYGONSCAN sub-chunk ${s}-${e}`);
            const part2 = await polygonscanGetLogs(subFilter);
            if (part2 && part2.length) results.push(...part2);
            await sleep(500 + Math.floor(Math.random() * 500));
          } else {
            console.log(`getLogs sub-chunk ${s}-${e}`);
            const part2 = await providerGetLogs(provider, subFilter);
            if (part2 && part2.length) results.push(...part2);
            await sleep(REQUEST_MIN_INTERVAL_MS + Math.floor(Math.random() * 200));
          }
        } catch (err2) {
          // Final retry for the sub-chunk
          console.warn(`sub-chunk failed ${s}-${e}, retrying once:`, err2 && err2.message ? err2.message : String(err2));
          await sleep(Math.max(3000, REQUEST_MIN_INTERVAL_MS));
          if (process.env.FORCE_POLYGONSCAN === '1' || process.env.FORCE_POLYGONSCAN === 'true') {
            const part3 = await polygonscanGetLogs(subFilter);
            if (part3 && part3.length) results.push(...part3);
            await sleep(500 + Math.floor(Math.random() * 500));
          } else {
            const part3 = await providerGetLogs(provider, subFilter);
            if (part3 && part3.length) results.push(...part3);
            await sleep(REQUEST_MIN_INTERVAL_MS + Math.floor(Math.random() * 200));
          }
        }
      }
    }
  }
  return results;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const latestBlock = await providerGetBlockNumber(provider);
  const nowTs = Math.floor(Date.now() / 1000);
  const startTs = nowTs - 24 * 3600;

  console.log(`Latest block: ${latestBlock}, now: ${nowTs}, windowStartTs: ${startTs}`);

  // Find exact block bounds for the 24h window
  const endBlock = latestBlock;
  const startBlock = await findBlockByTimestamp(provider, startTs, latestBlock);

  console.log(`Exact block window: ${startBlock}..${endBlock}`);

  const data = await loadData();
  if (!data.pools) data.pools = {};
  const runPools = [];

  for (const pool of POOLS) {
    const poolTopicEncoded = '0x' + pool.replace(/^0x/, '').padStart(64, '0');
    console.log(`Scanning USDC transfers for pool ${pool} in blocks ${startBlock}..${endBlock}`);
    let logsFrom = [];
    let logsTo = [];
    try {
      logsFrom = await fetchLogs(provider, startBlock, endBlock, poolTopicEncoded, 1);
      logsTo = await fetchLogs(provider, startBlock, endBlock, poolTopicEncoded, 2);
    } catch (e) {
      console.error('Error fetching logs for pool', pool, e.message || e);
      continue;
    }
    const allLogs = logsFrom.concat(logsTo);
    // Deduplicate logs by txHash+logIndex
    const seen = new Set();
    const deduped = [];
    for (const l of allLogs) {
      const key = `${l.transactionHash}-${String(l.logIndex)}`;
      if (!seen.has(key)) { seen.add(key); deduped.push(l); }
    }
    if (!allLogs || allLogs.length === 0) {
      console.log(`No USDC transfer logs for pool ${pool} in window.`);
      // still update lastUpdated timestamp
      data.pools[pool] = data.pools[pool] || { total_usd: 0, lastUpdated: 0 };
      data.pools[pool].lastUpdated = Date.now();
      continue;
    }

    let tokenSum = 0n;
    for (const l of deduped) {
      try {
        tokenSum += ethers.toBigInt(l.data);
      } catch (e) {
        // ignore malformed
      }
    }
    const tokenSumFloat = Number(ethers.formatUnits(tokenSum, USDC_DECIMALS));
    const totalDayUsd = tokenSumFloat; // 1 USDC = $1

    const prev = Number((data.pools[pool] && data.pools[pool].total_usd) || 0);
    const updated = prev + totalDayUsd;
    data.pools[pool] = {
      total_usd: Number(updated.toFixed(2)),
      lastUpdated: Date.now()
    };

    runPools.push({ pool, dayUsd: totalDayUsd, prev, updated: data.pools[pool].total_usd });

    console.log(`Pool ${pool}: dayUsd=${totalDayUsd} -> prev=${prev} updated=${data.pools[pool].total_usd}`);
  }

  data.lastUpdated = Date.now();
  await saveData(data);
  console.log('Saved updated pool totals.');

  // Persist run summary
  try {
    const runsFile = path.join(__dirname, '..', 'public', 'data', 'pool_volume_runs.json');
    let runs = [];
    try { runs = JSON.parse(fs.readFileSync(runsFile, 'utf8')) || []; } catch (e) { runs = []; }
    const runSummary = {
      timestamp: Date.now(),
      latestBlock,
      startBlock,
      endBlock,
      rpc: RPC,
      pools: runPools
    };
    runs.push(runSummary);
    if (runs.length > 200) runs = runs.slice(runs.length - 200);
    fs.writeFileSync(runsFile, JSON.stringify(runs, null, 2), 'utf8');
    console.log('Saved run summary to', runsFile);
  } catch (e) { console.warn('Failed to write run summary:', e && e.message); }
}

main().catch((e) => { console.error(e); process.exit(1); });
