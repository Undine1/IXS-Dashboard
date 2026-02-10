// Polygonscan-based updater: sums USDC transfers to/from a pair address
// Writes increments into public/data/pool_volume.json and updates a checkpoint.
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.POLYGONSCAN_KEY || process.env.POLYGONSCAN_API_KEY;
const USDC = (process.env.POLYGON_USDC || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174').toLowerCase();
const PAIR = (process.env.PAIR_ADDRESS || '0xd093a031df30f186976a1e2936b16d95ca7919d6').toLowerCase();

const CHECKPOINT = path.join(__dirname, '..', 'public', 'data', 'pool_volume_checkpoint.json');
const POOL_FILE = path.join(__dirname, '..', 'public', 'data', 'pool_volume.json');
const RUNS_FILE = path.join(__dirname, '..', 'public', 'data', 'pool_volume_runs.json');

if (!API_KEY) {
  console.error('POLYGONSCAN_KEY is required in environment');
  process.exit(2);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function getBlockByTimestamp(ts) {
  const url = `https://api.polygonscan.com/api?module=block&action=getblocknobytime&timestamp=${ts}&closest=before&apikey=${API_KEY}`;
  const j = await fetchJson(url);
  if (j.status !== '1' && !j.result) {
    throw new Error('Failed to get block by time: ' + JSON.stringify(j));
  }
  return Number(j.result.blockNumber || j.result);
}

async function fetchTokenTxs(startBlock, endBlock, page = 1, offset = 1000) {
  const url = `https://api.polygonscan.com/api?module=account&action=tokentx&contractaddress=${USDC}&address=${PAIR}&startblock=${startBlock}&endblock=${endBlock}&page=${page}&offset=${offset}&sort=asc&apikey=${API_KEY}`;
  const j = await fetchJson(url);
  if (j.status === '0' && j.message === 'No transactions found') return [];
  if (j.status !== '1') throw new Error('tokentx error: ' + JSON.stringify(j));
  return j.result || [];
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const checkpoint = readJson(CHECKPOINT, {});
  const startTs = checkpoint.lastTimestamp || (now - 3600);
  const endTs = now;

  console.log('Start ts', startTs, 'end ts', endTs);

  const startBlock = await getBlockByTimestamp(startTs);
  const endBlock = await getBlockByTimestamp(endTs);
  console.log('Block range', startBlock, endBlock);

  // fetch token transfers in a single page (offset high) and sum values
  let page = 1;
  let totalUsdc = 0;
  while (true) {
    const txs = await fetchTokenTxs(startBlock, endBlock, page, 1000);
    if (!txs || txs.length === 0) break;
    for (const tx of txs) {
      // tokenDecimal may be provided; default to 6 for USDC
      const dec = Number(tx.tokenDecimal || 6);
      const val = Number(tx.value || '0') / Math.pow(10, dec);
      totalUsdc += val;
    }
    if (txs.length < 1000) break;
    page += 1;
  }

  console.log('Total USDC transfers in window:', totalUsdc);

  // Load pool volume file and increment the matching pool entry (by address)
  const pools = readJson(POOL_FILE, {});
  const poolsMap = pools || {};
  const addr = PAIR.toLowerCase();
  if (!poolsMap[addr]) {
    poolsMap[addr] = { address: addr, total_usd: 0, lastUpdated: null };
  }
  poolsMap[addr].total_usd = Number(poolsMap[addr].total_usd || 0) + totalUsdc;
  poolsMap[addr].lastUpdated = new Date().toISOString();

  fs.writeFileSync(POOL_FILE, JSON.stringify(poolsMap, null, 2));

  // Append run summary
  const runs = readJson(RUNS_FILE, []);
  runs.push({ startTs, endTs, startBlock, endBlock, totalUsdc, ts: new Date().toISOString() });
  fs.writeFileSync(RUNS_FILE, JSON.stringify(runs.slice(-100), null, 2));

  // Save checkpoint
  fs.writeFileSync(CHECKPOINT, JSON.stringify({ lastTimestamp: endTs, lastBlock: endBlock }, null, 2));

  console.log('Done — wrote', POOL_FILE);
}

main().catch((e) => { console.error(e); process.exit(1); });
