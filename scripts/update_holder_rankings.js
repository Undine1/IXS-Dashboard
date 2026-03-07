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
const DEFAULT_LIMIT = 500;
const DEFAULT_LOG_CHUNK = 20000;
const DEFAULT_MIN_LOG_CHUNK = 500;
const DEFAULT_SAVE_EVERY_BATCHES = 10;

const ALCHEMY_API_KEY = String(process.env.ALCHEMY_API_KEY || '').trim();
const ALCHEMY_NETWORKS = {
  ethereum: 'eth-mainnet',
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
const STATE_FILE = path.join(STATE_DIR, 'holder_rankings_state.json');
const LABELS_FILE = path.join(STATE_DIR, 'holder_labels.json');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'holder_rankings.json');

let rpcCallCount = 0;
let retryCount = 0;

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
  fs.writeFileSync(filePath, `${payload}\n`);
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
  const urls = [];
  const add = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized || urls.includes(normalized)) return;
    urls.push(normalized);
  };

  if (chain === 'ethereum') {
    parseRpcListValue(process.env.ETHEREUM_RPC_LIST).forEach(add);
    add(process.env.ETHEREUM_RPC);
    add(process.env.ETH_RPC);
  } else if (chain === 'base') {
    parseRpcListValue(process.env.BASE_RPC_LIST).forEach(add);
    add(process.env.BASE_RPC);
    add('https://mainnet.base.org');
  } else if (chain === 'polygon') {
    parseRpcListValue(process.env.POLYGON_RPC_LIST).forEach(add);
    add(process.env.POLYGON_RPC);
  }

  const alchemyNetwork = ALCHEMY_NETWORKS[chain];
  if (alchemyNetwork && ALCHEMY_API_KEY) {
    add(`https://${alchemyNetwork}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`);
  }

  return urls;
}

function getAlchemyRpcUrlForChain(chain) {
  const network = ALCHEMY_NETWORKS[chain];
  if (!network || !ALCHEMY_API_KEY) return null;
  return `https://${network}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
}

async function requestWithRetries(url, options = {}) {
  const maxAttempts = Math.max(1, Number(process.env.API_MAX_ATTEMPTS || 5));
  const baseDelayMs = Math.max(50, Number(process.env.API_BASE_DELAY_MS || 500));
  const maxDelayMs = Math.max(baseDelayMs, Number(process.env.API_MAX_DELAY_MS || 30000));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
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
    throw new Error(`No RPC URL configured for ${chain}. Set ${chain.toUpperCase()}_RPC or ALCHEMY_API_KEY.`);
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
  const url = getAlchemyRpcUrlForChain(chain);
  if (!url) {
    throw new Error(`Alchemy is not configured for ${chain}`);
  }

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
    throw new Error(`Alchemy HTTP ${response.status} ${response.statusText} for ${method}: ${text}`);
  }

  const payload = await response.json();
  if (payload && payload.error) {
    const message = payload.error.message || JSON.stringify(payload.error);
    throw new Error(`Alchemy ${method} error for ${chain}: ${message}`);
  }

  return payload.result;
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
    throw new Error(
      `Negative balance computed for ${holder} on ${chain}. The saved state is incomplete or the configured start block is too late.`,
    );
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

async function processChainViaAlchemyAssetTransfers(state, chainState, config, latestBlock, contractStartBlock) {
  const saveEveryBatches = Math.max(
    1,
    Number(process.env.HOLDER_RANKINGS_SAVE_EVERY_BATCHES || DEFAULT_SAVE_EVERY_BATCHES),
  );
  const lastScannedBlock = toNonNegativeInteger(chainState.lastScannedBlock);
  const startBlock = lastScannedBlock == null ? contractStartBlock : lastScannedBlock + 1;

  if (startBlock > latestBlock) {
    console.log(
      `[holder-rankings] ${config.chain}: already synced at block ${lastScannedBlock} (latest ${latestBlock})`,
    );
    return { startBlock, latestBlock, logsFetched: 0, logsApplied: 0, mode: 'alchemy_getAssetTransfers' };
  }

  const existingCursor =
    chainState.assetTransfersCursor && typeof chainState.assetTransfersCursor === 'object'
      ? chainState.assetTransfersCursor
      : null;
  const cursorState = existingCursor || {
    fromBlock: startBlock,
    toBlock: latestBlock,
    pageKey: null,
  };

  if (toNonNegativeInteger(cursorState.fromBlock) == null) cursorState.fromBlock = startBlock;
  if (toNonNegativeInteger(cursorState.toBlock) == null) cursorState.toBlock = latestBlock;
  if (typeof cursorState.pageKey !== 'string') cursorState.pageKey = null;

  chainState.assetTransfersCursor = cursorState;

  let logsFetched = 0;
  let logsApplied = 0;
  let batchesSinceSave = 0;
  let currentPageKey = cursorState.pageKey;
  const queryFromBlock = toNonNegativeInteger(cursorState.fromBlock) ?? startBlock;
  const queryToBlock = toNonNegativeInteger(cursorState.toBlock) ?? latestBlock;

  console.log(
    `[holder-rankings] ${config.chain}: paging transfers ${queryFromBlock}-${queryToBlock} via alchemy_getAssetTransfers`,
  );

  while (true) {
    const page = await fetchAssetTransfersPage(
      config.chain,
      config.address,
      queryFromBlock,
      queryToBlock,
      currentPageKey,
    );

    for (const transfer of page.transfers) {
      if (applyAssetTransfer(state, config.chain, transfer)) {
        logsApplied += 1;
      }
    }

    logsFetched += page.transfers.length;
    const processedLogCount = toNonNegativeInteger(chainState.processedLogCount) ?? 0;
    chainState.processedLogCount = processedLogCount + page.transfers.length;
    chainState.latestBlockAtRun = latestBlock;
    currentPageKey = page.pageKey;
    chainState.assetTransfersCursor.pageKey = currentPageKey;

    batchesSinceSave += 1;
    if (batchesSinceSave >= saveEveryBatches) {
      persistState(state);
      batchesSinceSave = 0;
    }

    if (!currentPageKey) {
      chainState.lastScannedBlock = queryToBlock;
      delete chainState.assetTransfersCursor;
      break;
    }
  }

  persistState(state);

  return {
    startBlock: queryFromBlock,
    latestBlock: queryToBlock,
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
      labelCategory: holderLabels && holderLabels[holder] ? holderLabels[holder].category : null,
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
      labelCategory: entry.labelCategory,
    })),
    totalRowCount: entries.length,
    lastRefreshed: state.updatedAt || null,
    source: 'rpc-snapshot',
  };
}

async function processChain(state, config) {
  if (!isValidAddress(config.address)) {
    throw new Error(`Invalid token address for ${config.chain}: ${config.address}`);
  }

  const latestBlock = await getLatestBlockRpc(config.chain);
  const chainState =
    state.chains[config.chain] && typeof state.chains[config.chain] === 'object'
      ? state.chains[config.chain]
      : {};

  state.chains[config.chain] = chainState;
  chainState.tokenAddress = config.address;
  chainState.decimals = config.decimals;
  chainState.latestBlockAtRun = latestBlock;

  let contractStartBlock =
    toNonNegativeInteger(chainState.contractStartBlock) ?? toNonNegativeInteger(process.env[config.startBlockEnv]);

  if (getAlchemyRpcUrlForChain(config.chain)) {
    if (contractStartBlock == null) {
      contractStartBlock = 0;
    }
    chainState.contractStartBlock = contractStartBlock;
    return processChainViaAlchemyAssetTransfers(
      state,
      chainState,
      config,
      latestBlock,
      contractStartBlock,
    );
  }

  if (contractStartBlock == null) {
    console.log(`[holder-rankings] Resolving deployment block for ${config.chain} ${config.address}`);
    contractStartBlock = await findContractDeploymentBlock(config.chain, config.address, latestBlock);
  }

  chainState.contractStartBlock = contractStartBlock;

  const lastScannedBlock = toNonNegativeInteger(chainState.lastScannedBlock);
  const startBlock = lastScannedBlock == null ? contractStartBlock : lastScannedBlock + 1;

  if (startBlock > latestBlock) {
    console.log(
      `[holder-rankings] ${config.chain}: already synced at block ${lastScannedBlock} (latest ${latestBlock})`,
    );
    return { startBlock, latestBlock, logsFetched: 0, logsApplied: 0 };
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
      const logs = await fetchTransferLogs(config.chain, config.address, cursor, endBlock);
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
        persistState(state);
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

  persistState(state);

  return {
    startBlock,
    latestBlock,
    logsFetched,
    logsApplied,
  };
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

main().catch((error) => {
  console.error('[holder-rankings] Update failed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
