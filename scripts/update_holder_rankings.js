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

loadEnvLocal();

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

let rpcCallCount = 0;
let retryCount = 0;
// chain -> Set<address> of holders whose Transfer-event sum went negative this
// run and must be reconciled against on-chain balanceOf after the scan. IXS is
// not a vanilla ERC-20 (its balanceOf is changed by mechanics that don't emit
// Transfer events — reflections/fees/migration credits), so summing transfers
// can drive a high-volume pass-through address below zero even with a complete,
// correct event history.
const pendingBalanceReconcile = new Map();

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

// Global request pacing: enforce a minimum gap between outbound RPC requests so
// the updater never bursts many calls in the same second. Alchemy's throughput
// (CUPS) ceiling is account-wide, so flattening this run's peak leaves headroom
// for other apps on the same key. Tune/disable via RPC_MIN_INTERVAL_MS.
let lastRpcRequestAt = 0;
async function paceRpcRequests() {
  const minIntervalMs = Number(process.env.RPC_MIN_INTERVAL_MS || 100);
  if (!(minIntervalMs > 0)) return;
  const waitMs = lastRpcRequestAt + minIntervalMs - Date.now();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastRpcRequestAt = Date.now();
}

async function requestWithRetries(url, options = {}) {
  const maxAttempts = Math.max(1, Number(process.env.API_MAX_ATTEMPTS || 5));
  const baseDelayMs = Math.max(50, Number(process.env.API_BASE_DELAY_MS || 500));
  const maxDelayMs = Math.max(baseDelayMs, Number(process.env.API_MAX_DELAY_MS || 30000));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await paceRpcRequests();
      rpcCallCount += 1;
      const response = await fetch(url, options);
      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        if (attempt === maxAttempts) return response;

        retryCount += 1;
        const waitMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      return response;
    } catch (error) {
      if (attempt === maxAttempts) throw error;

      retryCount += 1;
      const waitMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw new Error(`Request retries exhausted for ${url}`);
}

async function rpcCall(chain, method, params) {
  const urls = getRpcUrlsForChain(chain);
  if (!urls.length) {
    throw new Error(
      `No RPC URL configured for ${chain}. Set ALCHEMY_API_KEY, BACKUP_INFURA_API_KEY, or BACKUP_CHAINSTACK_BASE_RPC_URL.`,
    );
  }

  let lastError = null;

  for (const url of urls) {
    try {
      const response = await requestWithRetries(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`RPC HTTP ${response.status} ${response.statusText} at ${url}: ${text}`);
      }

      const payload = await response.json();
      if (payload && payload.error) {
        const message = payload.error.message || JSON.stringify(payload.error);
        throw new Error(`RPC ${method} error at ${url}: ${message}`);
      }

      return payload.result;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`RPC ${method} failed for ${chain}`);
}

async function alchemyCall(chain, method, params) {
  const urls = getAlchemyRpcUrlsForChain(chain);
  if (!urls.length) {
    throw new Error(`Alchemy is not configured for ${chain}`);
  }

  let lastError = null;
  for (const url of urls) {
    try {
      const response = await requestWithRetries(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Alchemy HTTP ${response.status} ${response.statusText} for ${method} at ${url}: ${text}`);
      }

      const payload = await response.json();
      if (payload && payload.error) {
        const message = payload.error.message || JSON.stringify(payload.error);
        throw new Error(`Alchemy ${method} error for ${chain} at ${url}: ${message}`);
      }

      return payload.result;
    } catch (error) {
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

async function getLatestBlockRpc(chain) {
  const value = await rpcCall(chain, 'eth_blockNumber', []);
  const latestBlock = fromRpcHex(value);
  if (!Number.isFinite(latestBlock)) {
    throw new Error(`Invalid eth_blockNumber result for ${chain}: ${value}`);
  }
  return latestBlock;
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

  return Array.isArray(result) ? result : [];
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

function setRawBalance(holders, holder, chain, nextBalance) {
  if (!isValidAddress(holder) || holder === ZERO_ADDRESS) return;
  if (nextBalance < 0n) {
    // Don't fail the run (or silently clamp and corrupt the ranking): record
    // the address and reconcile it against the authoritative on-chain
    // balanceOf after the scan completes. See pendingBalanceReconcile above.
    let flagged = pendingBalanceReconcile.get(chain);
    if (!flagged) {
      flagged = new Set();
      pendingBalanceReconcile.set(chain, flagged);
    }
    flagged.add(holder);
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
    version: 1,
    updatedAt: null,
    chains: {},
    holders: {},
  };
}

function normalizeState(rawState) {
  const state = createDefaultState();
  if (!rawState || typeof rawState !== 'object') return state;

  if (rawState.version != null) state.version = Number(rawState.version) || 1;
  if (typeof rawState.updatedAt === 'string') state.updatedAt = rawState.updatedAt;

  if (rawState.chains && typeof rawState.chains === 'object') {
    state.chains = rawState.chains;
  }

  if (rawState.holders && typeof rawState.holders === 'object') {
    state.holders = rawState.holders;
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
  chainState.tokenAddress = config.address;
  chainState.decimals = config.decimals;
  chainState.latestBlockAtRun = latestBlock;
  return chainState;
}

function persistState(state) {
  writeJson(STATE_FILE, state, 0);
}

async function fetchAssetTransfersPage(chain, tokenAddress, fromBlock, toBlock, pageKey) {
  const params = {
    fromBlock: asRpcHex(fromBlock),
    toBlock: asRpcHex(toBlock),
    category: ['erc20'],
    contractAddresses: [tokenAddress],
    withMetadata: false,
    excludeZeroValue: true,
    maxCount: asRpcHex(Math.max(1, Number(process.env.HOLDER_RANKINGS_ASSET_TRANSFERS_PAGE_SIZE || 1000))),
  };

  if (pageKey) {
    params.pageKey = pageKey;
  }

  const result = await alchemyCall(chain, 'alchemy_getAssetTransfers', [params]);
  return {
    pageKey: result && typeof result.pageKey === 'string' ? result.pageKey : null,
    transfers: Array.isArray(result && result.transfers) ? result.transfers : [],
  };
}

async function processChainViaAlchemyAssetTransfers(state, chainState, config, latestBlock, contractStartBlock, deps = {}) {
  // deps.fetchPage / deps.persist are injectable for tests; production uses the
  // real Alchemy fetcher and the disk persister.
  const fetchPage = deps.fetchPage || fetchAssetTransfersPage;
  const persist = deps.persist || persistState;
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
    chainState.processedLogCount = 0;
  }

  console.log(
    `[holder-rankings] ${config.chain}: scanning transfers ${startBlock}-${latestBlock} via alchemy_getAssetTransfers (window ${windowSize})`,
  );

  let logsFetched = 0;
  let logsApplied = 0;

  for (let from = startBlock; from <= latestBlock; ) {
    const to = Math.min(latestBlock, from + windowSize - 1);

    // Paginate this window to completion within this run. pageKey lives only in
    // memory here and is never persisted.
    let pageKey = null;
    do {
      const page = await fetchPage(config.chain, config.address, from, to, pageKey);
      for (const transfer of page.transfers) {
        if (applyAssetTransfer(state, config.chain, transfer)) {
          logsApplied += 1;
        }
      }
      logsFetched += page.transfers.length;
      const processedLogCount = toNonNegativeInteger(chainState.processedLogCount) ?? 0;
      chainState.processedLogCount = processedLogCount + page.transfers.length;
      pageKey = page.pageKey;
    } while (pageKey);

    // Window complete: advance the durable checkpoint and persist. If the run is
    // interrupted between windows, the next run resumes from lastScannedBlock+1
    // (a block number), so nothing is ever re-applied.
    chainState.lastScannedBlock = to;
    chainState.latestBlockAtRun = latestBlock;
    from = to + 1;
    persist(state);
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
  let logsFetched = 0;
  let logsApplied = 0;
  let batchesSinceSave = 0;

  console.log(
    `[holder-rankings] ${config.chain}: scanning blocks ${startBlock}-${latestBlock} with chunk ${chunkSize}`,
  );

  while (cursor <= latestBlock) {
    const endBlock = Math.min(latestBlock, cursor + chunkSize - 1);

    try {
      const logs = await fetchLogs(config.chain, config.address, cursor, endBlock);
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
        persist(state);
        batchesSinceSave = 0;
      }

      cursor = endBlock + 1;

      if (logs.length === 0 && chunkSize < maxChunk) {
        chunkSize = Math.min(maxChunk, chunkSize * 2);
      }
    } catch (error) {
      if (chunkSize <= minChunk) {
        throw new Error(
          `[holder-rankings] ${config.chain}: failed scanning blocks ${cursor}-${endBlock}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const nextChunkSize = Math.max(minChunk, Math.floor(chunkSize / 2));
      console.warn(
        `[holder-rankings] ${config.chain}: reducing log chunk ${chunkSize} -> ${nextChunkSize} after RPC error`,
      );
      chunkSize = nextChunkSize;
    }
  }

  persist(state);

  return {
    startBlock,
    latestBlock,
    logsFetched,
    logsApplied,
  };
}

// After a chain's transfer scan, replace any flagged (negative event-sum)
// holders with their authoritative on-chain balanceOf at the scanned block, so
// these values are consistent with the event-summed balances of every other
// holder. Never throws: a balanceOf RPC failure leaves the address at its 0
// placeholder and is surfaced as a warning for the next run to retry.
async function reconcileFlaggedBalances(state, config, chainState) {
  const flagged = pendingBalanceReconcile.get(config.chain);
  if (!flagged || flagged.size === 0) return { reconciled: 0, failed: 0 };

  const addresses = [...flagged];
  flagged.clear();

  const scannedBlock =
    toNonNegativeInteger(chainState.lastScannedBlock) ?? toNonNegativeInteger(chainState.latestBlockAtRun);
  const blockTag = scannedBlock == null ? 'latest' : asRpcHex(scannedBlock);

  console.warn(
    `[holder-rankings] ${config.chain}: ${addresses.length} address(es) had a negative Transfer-event sum (expected for IXS, whose balanceOf is not the net of Transfer events); reconciling against on-chain balanceOf @ block ${scannedBlock ?? 'latest'}`,
  );

  let reconciled = 0;
  let failed = 0;
  for (const address of addresses) {
    try {
      const data = `0x70a08231000000000000000000000000${address.slice(2)}`;
      const result = await rpcCall(config.chain, 'eth_call', [{ to: config.address, data }, blockTag]);
      let raw;
      try {
        raw = BigInt(result);
      } catch {
        throw new Error(`invalid balanceOf result: ${result}`);
      }
      if (raw < 0n) throw new Error(`negative balanceOf result: ${raw}`);

      // Write the authoritative value directly (balanceOf is always >= 0, so
      // this never re-flags).
      const existing =
        state.holders[address] && typeof state.holders[address] === 'object' ? state.holders[address] : {};
      if (raw === 0n) {
        delete existing[config.chain];
      } else {
        existing[config.chain] = raw.toString();
      }
      if (Object.keys(existing).length === 0) {
        delete state.holders[address];
      } else {
        state.holders[address] = existing;
      }
      reconciled += 1;
    } catch (error) {
      failed += 1;
      console.warn(
        `[holder-rankings] ${config.chain}: balanceOf reconciliation failed for ${address} (left at 0): ${
          error && error.message ? error.message : String(error)
        }`,
      );
    }
  }

  console.log(
    `[holder-rankings] ${config.chain}: reconciled ${reconciled} address(es) against chain${
      failed ? `, ${failed} failed (left at 0, will retry next run)` : ''
    }`,
  );
  if (reconciled || failed) persistState(state);
  return { reconciled, failed };
}

async function processChain(state, config) {
  if (!isValidAddress(config.address)) {
    throw new Error(`Invalid token address for ${config.chain}: ${config.address}`);
  }

  const latestBlock = await getLatestBlockRpc(config.chain);
  let chainState = ensureChainState(state, config, latestBlock);

  let contractStartBlock =
    toNonNegativeInteger(chainState.contractStartBlock) ?? toNonNegativeInteger(process.env[config.startBlockEnv]);
  // Defensive: negative balances are reconciled (not thrown) since IXS isn't a
  // vanilla ERC-20, so this resync path is dormant — it only fires if some
  // other code path ever throws a state-integrity error.
  let hasRetriedFromScratch = false;
  let summary;

  while (true) {
    const attemptSnapshot = snapshotChainState(state, config.chain);

    try {
      if (getAlchemyRpcUrlForChain(config.chain)) {
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
          );
          break;
        } catch (error) {
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
          persistState(state);

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

      summary = await processChainViaStandardRpcLogs(state, chainState, config, latestBlock, contractStartBlock);
      break;
    } catch (error) {
      if (!isStateIntegrityError(error) || hasRetriedFromScratch) {
        throw error;
      }

      console.warn(
        `[holder-rankings] ${config.chain}: detected incomplete saved state, clearing ${config.chain} balances and rebuilding from block ${contractStartBlock}`,
      );
      resetChainForFullResync(state, chainState, config.chain, contractStartBlock, latestBlock);
      persistState(state);
      hasRetriedFromScratch = true;
    }
  }

  const recon = await reconcileFlaggedBalances(state, config, chainState);
  if (recon.reconciled || recon.failed) {
    summary = { ...summary, reconciled: recon.reconciled, reconcileFailed: recon.failed };
  }
  return summary;
}

async function main() {
  ensureDirectory(STATE_DIR);
  ensureDirectory(OUTPUT_DIR);

  const state = normalizeState(readJson(STATE_FILE, createDefaultState()));
  const holderLabels = readHolderLabelRegistry();
  for (const config of TOKEN_CONFIGS) {
    const summary = await processChain(state, config);
    console.log(
      `[holder-rankings] ${config.chain}: scanned ${summary.startBlock}-${summary.latestBlock}, fetched ${summary.logsFetched} logs, applied ${summary.logsApplied}`,
    );
  }

  const completedAt = new Date().toISOString();
  state.updatedAt = completedAt;
  persistState(state);

  const publicPayload = buildPublicPayload(state, holderLabels);
  writeJson(OUTPUT_FILE, publicPayload, 2);

  console.log(
    `[holder-rankings] Wrote ${publicPayload.rows.length} rows (${publicPayload.totalRowCount} holders) to ${OUTPUT_FILE}`,
  );
  console.log(
    `[holder-rankings] Completed with ${rpcCallCount} RPC calls and ${retryCount} retries. Last refreshed: ${completedAt}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[holder-rankings] Update failed:', error && error.stack ? error.stack : error);
    process.exit(1);
  });
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
  setRawBalance,
  applyTransferDelta,
  applyAssetTransfer,
  addThousandsSeparators,
  formatTokenAmount,
  createDefaultState,
  ensureChainState,
  clearChainBalances,
  processChainViaAlchemyAssetTransfers,
  processChainViaStandardRpcLogs,
};
