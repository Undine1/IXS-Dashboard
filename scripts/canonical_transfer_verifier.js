// Bind reported events to canonical block hashes before callers mutate balances
// or volume. Log mode checks each reported block hash; indexed mode compares the
// event multiset with hash-bound logs within reported blocks. Neither proves
// completeness for an entirely omitted block or independently verifies provider
// honesty. Never share this cache between pinned scans or across process runs.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ADDRESS_TOPIC = /^0x0{24}[0-9a-f]{40}$/i;

function requireCanonical(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: 'RPC_CANONICAL_MISMATCH' });
}

function blockNumber(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  requireCanonical(typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value), 'Invalid event block number');
  const number = Number(BigInt(value));
  requireCanonical(Number.isSafeInteger(number) && number >= 0, 'Unsafe event block number');
  return number;
}

function normalizeHeader(value, expectedNumber) {
  requireCanonical(value && typeof value === 'object', 'Missing canonical event header');
  const number = blockNumber(value.blockNumber ?? value.number);
  const hash = value.blockHash ?? value.hash;
  requireCanonical(number === expectedNumber && HASH.test(hash), 'Unexpected canonical event header');
  return { number, hash: hash.toLowerCase() };
}

function normalizeLog(log, tokenAddress) {
  requireCanonical(log && ADDRESS.test(log.address) && log.address.toLowerCase() === tokenAddress &&
    HASH.test(log.blockHash) && HASH.test(log.transactionHash) && HASH.test(log.data) && log.removed === false &&
    Array.isArray(log.topics) && log.topics.length === 3 && String(log.topics[0]).toLowerCase() === TRANSFER_TOPIC &&
    ADDRESS_TOPIC.test(log.topics[1]) && ADDRESS_TOPIC.test(log.topics[2]), 'Malformed canonical Transfer event');
  const number = blockNumber(log.blockNumber);
  requireCanonical(typeof log.logIndex === 'string' && /^0x[0-9a-f]+$/i.test(log.logIndex), 'Missing canonical event identity');
  return {
    number, blockHash: log.blockHash.toLowerCase(), transactionHash: log.transactionHash.toLowerCase(),
    logIndex: BigInt(log.logIndex).toString(),
    from: `0x${log.topics[1].slice(-40).toLowerCase()}`,
    to: `0x${log.topics[2].slice(-40).toLowerCase()}`,
    raw: BigInt(log.data).toString(),
  };
}

function eventKey(event) {
  return JSON.stringify([event.transactionHash, event.from, event.to, event.raw]);
}

function multiset(events) {
  const counts = new Map();
  for (const event of events) {
    const key = eventKey(event);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function createCanonicalTransferVerifier({ getBlockHeader, getLogsByHash, checkDeadline = () => {}, pinnedHeaders = [] }) {
  const headers = new Map();
  const logsByHash = new Map();
  const pinned = new Map();
  for (const value of pinnedHeaders) {
    const number = blockNumber(value.blockNumber ?? value.number);
    const hash = normalizeHeader(value, number).hash;
    requireCanonical(!pinned.has(number) || pinned.get(number) === hash, 'Conflicting pinned event headers');
    pinned.set(number, hash);
  }

  async function memoize(cache, key, read) {
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(read));
    try { return await cache.get(key); }
    catch (error) { cache.delete(key); throw error; }
  }

  async function headerFor(number) {
    checkDeadline();
    return memoize(headers, number, async () => {
      const header = normalizeHeader(await getBlockHeader(number), number);
      requireCanonical(!pinned.has(number) || pinned.get(number) === header.hash, 'Pinned event block hash changed');
      return header;
    });
  }

  async function canonicalEvents(number, tokenAddress) {
    const header = await headerFor(number);
    return memoize(logsByHash, `${header.hash}:${tokenAddress}`, async () => {
      checkDeadline();
      const result = await getLogsByHash(header.hash, tokenAddress);
      requireCanonical(Array.isArray(result), 'Hash-bound Transfer result must be an array');
      const events = result.map((log) => normalizeLog(log, tokenAddress));
      const identities = new Set();
      for (const event of events) {
        requireCanonical(event.number === number && event.blockHash === header.hash,
          'RPC ignored the requested Transfer block hash');
        requireCanonical(!identities.has(event.logIndex), 'Duplicate event in hash-bound Transfer result');
        identities.add(event.logIndex);
      }
      return events;
    });
  }

  return {
    async verifyLogs(logs, address) {
      requireCanonical(ADDRESS.test(address) && Array.isArray(logs), 'Invalid Transfer verification input');
      const tokenAddress = address.toLowerCase();
      const identities = new Map();
      for (const log of logs) {
        checkDeadline();
        const event = normalizeLog(log, tokenAddress);
        const identity = `${event.blockHash}:${event.logIndex}`;
        const fingerprint = eventKey(event);
        requireCanonical(!identities.has(identity) || identities.get(identity) === fingerprint,
          'Conflicting events share a canonical Transfer log index');
        identities.set(identity, fingerprint);
        const header = await headerFor(event.number);
        requireCanonical(event.blockHash === header.hash, 'Transfer log belongs to a different canonical block');
      }
    },

    async verifyAssetTransfers(transfers, address, { participant } = {}) {
      requireCanonical(ADDRESS.test(address) && Array.isArray(transfers) &&
        (participant == null || ADDRESS.test(participant)), 'Invalid Asset Transfers verification input');
      const tokenAddress = address.toLowerCase();
      const filterAddress = participant?.toLowerCase();
      const groups = new Map();
      for (const transfer of transfers) {
        requireCanonical(transfer && HASH.test(transfer.hash) && ADDRESS.test(transfer.from) && ADDRESS.test(transfer.to) &&
          transfer.rawContract && ADDRESS.test(transfer.rawContract.address) &&
          transfer.rawContract.address.toLowerCase() === tokenAddress &&
          typeof transfer.rawContract.value === 'string' && /^0x[0-9a-f]+$/i.test(transfer.rawContract.value),
        'Malformed indexed Transfer verification input');
        const event = {
          transactionHash: transfer.hash.toLowerCase(), from: transfer.from.toLowerCase(), to: transfer.to.toLowerCase(),
          raw: BigInt(transfer.rawContract.value).toString(),
        };
        requireCanonical(!filterAddress || event.from === filterAddress || event.to === filterAddress,
          'Indexed Transfer is outside the requested participant');
        const number = blockNumber(transfer.blockNum);
        if (!groups.has(number)) groups.set(number, []);
        // The indexed endpoint is requested with excludeZeroValue=true.
        if (event.raw !== '0') groups.get(number).push(event);
      }
      for (const [number, reported] of groups) {
        const canonical = (await canonicalEvents(number, tokenAddress))
          .filter((event) => event.raw !== '0' && (!filterAddress || event.from === filterAddress || event.to === filterAddress));
        const actual = multiset(reported), expected = multiset(canonical);
        requireCanonical(actual.size === expected.size && [...expected].every(([key, count]) => actual.get(key) === count),
          'Indexed Transfers disagree with hash-bound canonical events');
      }
    },
  };
}

module.exports = { createCanonicalTransferVerifier };
