function parseRpcBlockNumber(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function getEthGetLogsRangeSpan(method, params) {
  if (method !== 'eth_getLogs' || !Array.isArray(params)) return null;
  const filter = params[0];
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null;
  const fromBlock = parseRpcBlockNumber(filter.fromBlock);
  const toBlock = parseRpcBlockNumber(filter.toBlock);
  if (fromBlock == null || toBlock == null || toBlock < fromBlock) return null;
  return toBlock - fromBlock + 1;
}

function normalizeCeiling(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

// Only explicit provider-wide block caps are safe to remember across filters.
// A "this range should work" suggestion can depend on the current address or
// topics, so callers may use it for one immediate shrink but must not cache it.
function inferExplicitProviderRangeCeiling(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  const match = message.match(/up to a (\d+) block range/i);
  return match ? normalizeCeiling(match[1]) : null;
}

function providerRangeCeilingKey(chain, method, url) {
  return `${String(chain || '')} ${String(method || '')} ${String(url || '')}`;
}

function createProviderRangeCeilingTracker() {
  const ceilings = new Map();

  function get(chain, method, url) {
    return ceilings.get(providerRangeCeilingKey(chain, method, url)) ?? null;
  }

  return {
    remember(chain, method, url, value) {
      const ceiling = normalizeCeiling(value);
      if (ceiling == null || method !== 'eth_getLogs' || !url) return null;
      const key = providerRangeCeilingKey(chain, method, url);
      const previous = ceilings.get(key);
      const learned = previous == null ? ceiling : Math.min(previous, ceiling);
      ceilings.set(key, learned);
      return learned;
    },

    get,

    getSkipDecision(chain, method, url, params) {
      const requestedSpan = getEthGetLogsRangeSpan(method, params);
      const ceiling = get(chain, method, url);
      if (requestedSpan == null || ceiling == null || requestedSpan <= ceiling) return null;
      return { ceiling, requestedSpan };
    },

    clear() {
      ceilings.clear();
    },
  };
}

function chooseRetryRangeCeiling(values) {
  const ceilings = values.map(normalizeCeiling).filter((value) => value != null);
  return ceilings.length > 0 ? Math.max(...ceilings) : null;
}

module.exports = {
  parseRpcBlockNumber,
  getEthGetLogsRangeSpan,
  inferExplicitProviderRangeCeiling,
  providerRangeCeilingKey,
  createProviderRangeCeilingTracker,
  chooseRetryRangeCeiling,
};
