// Polygonscan-based updater: sums USDC transfers to/from a pair address
// Writes increments into public/data/pool_volume.json and updates a checkpoint.
const fs = require('fs');
const path = require('path');

// Prefer ETHERSCAN_API_KEY (Etherscan v2); fall back to legacy Polygonscan key
const API_KEY = process.env.ETHERSCAN_API_KEY || process.env.POLYGONSCAN_KEY || process.env.POLYGONSCAN_API_KEY;
// Etherscan V2 base endpoint; use chainid=137 for Polygon
const ETHERSCAN_V2_BASE = 'https://api.etherscan.io/v2/api?chainid=137';
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
  const url = `${ETHERSCAN_V2_BASE}&module=block&action=getblocknobytime&timestamp=${ts}&closest=before&apikey=${API_KEY}`;
  const j = await fetchJson(url);
  if (j.status !== '1' && !j.result) {
    throw new Error('Failed to get block by time: ' + JSON.stringify(j));
  }
  return Number(j.result.blockNumber || j.result);
}

async function fetchTokenTxs(startBlock, endBlock, page = 1, offset = 1000) {
  const url = `${ETHERSCAN_V2_BASE}&module=account&action=tokentx&contractaddress=${USDC}&address=${PAIR}&startblock=${startBlock}&endblock=${endBlock}&page=${page}&offset=${offset}&sort=asc&apikey=${API_KEY}`;
  const j = await fetchJson(url);
  if (j.status === '0' && j.message === 'No transactions found') return [];
  if (j.status !== '1') throw new Error('tokentx error: ' + JSON.stringify(j));
  return j.result || [];
}

// Fetch logs for the pair address between blocks (etherscan v2 logs endpoint)
async function fetchLogs(startBlock, endBlock, page = 1, offset = 1000) {
  const url = `${ETHERSCAN_V2_BASE}&module=logs&action=getLogs&address=${PAIR}&fromBlock=${startBlock}&toBlock=${endBlock}&page=${page}&offset=${offset}&apikey=${API_KEY}`;
  const j = await fetchJson(url);
  if (j.status === '0' && j.message && j.message.includes('No records')) return [];
  if (j.status !== '1') throw new Error('getLogs error: ' + JSON.stringify(j));
  return j.result || [];
}

// Call token0() on the pair to determine which slot is USDC
async function getPairToken0() {
  const data = '0x0dfe1681'; // token0()
  const url = `${ETHERSCAN_V2_BASE}&module=proxy&action=eth_call&to=${PAIR}&data=${data}&tag=latest&apikey=${API_KEY}`;
  const j = await fetchJson(url);
  if (!j.result) throw new Error('eth_call token0 failed: ' + JSON.stringify(j));
  const res = j.result; // 0x...32 bytes
  const addr = '0x' + res.slice(res.length - 40);
  return addr.toLowerCase();
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
  // --- Swap-log based volume (preferred) ---
  const token0Addr = await getPairToken0();
  const usdcAddr = USDC.toLowerCase();
  const usdcIsToken0 = token0Addr === usdcAddr;

  let page = 1;
  let totalUsdcBig = 0n;
  while (true) {
    const logs = await fetchLogs(startBlock, endBlock, page, 1000);
    if (!logs || logs.length === 0) break;
    for (const lg of logs) {
      // Swap events in UniswapV2-style pairs have 4 uint256 in data (128 bytes)
      if (!lg.data || lg.data.length !== 2 + 32 * 4 * 2) {
        // data length not 0x + 256 hex chars (4*32 bytes)
        continue;
      }
      const d = lg.data.slice(2); // remove 0x
      const amount0In = BigInt('0x' + d.slice(0, 64));
      const amount1In = BigInt('0x' + d.slice(64, 128));
      const amount0Out = BigInt('0x' + d.slice(128, 192));
      const amount1Out = BigInt('0x' + d.slice(192, 256));
      const usdcAmount = usdcIsToken0 ? (amount0In + amount0Out) : (amount1In + amount1Out);
      totalUsdcBig += usdcAmount;
    }
    if (logs.length < 1000) break;
    page += 1;
  }

  // USDC has 6 decimals
  const totalUsdc = Number(totalUsdcBig) / 1e6;
  console.log('Total USDC swapped in window:', totalUsdc);

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
