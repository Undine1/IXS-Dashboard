// Shared transport safeguards for read-only RPC. No environment files are read.
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_COOLDOWN_MS = 30000;

function positiveBounded(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(maximum, Math.ceil(parsed)) : fallback;
}

function sanitizeRpcMessage(value, env = process.env) {
  let message = value instanceof Error ? value.message : String(value ?? '');
  // Also safe as Array.map(sanitizeRpcMessage), whose second argument is an
  // index rather than an environment object.
  const secretEnv = env && typeof env === 'object' ? env : process.env;
  const secrets = Object.entries(secretEnv)
    .filter(([key, secret]) => /(?:API_KEY|RPC_URL|LIVE_READ_TOKEN)$/.test(key) && typeof secret === 'string' && secret.trim())
    .map(([, secret]) => secret.trim())
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    message = message.split(secret).join('[redacted]');
    message = message.split(encodeURIComponent(secret)).join('[redacted]');
  }
  // Full configured endpoints are scrubbed first: some providers place the
  // credential in the hostname itself. Other URLs retain only their hostname.
  message = message.replace(/https?:\/\/[^\s<>"'`]+/gi, (raw) => {
    try { return `[RPC ${new URL(raw).hostname}]`; } catch { return '[RPC URL]'; }
  });
  return message;
}

function transportError(error) {
  const safe = new Error(sanitizeRpcMessage(error));
  safe.name = error?.name || 'Error';
  const code = error?.code || error?.cause?.code;
  if (code != null) safe.code = code;
  if (Number.isFinite(error?.status)) safe.status = error.status;
  return safe;
}

async function withRpcResponse(url, options, consume, config = {}) {
  const timeoutMs = positiveBounded(config.timeoutMs ?? process.env.RPC_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 120000);
  const controller = new AbortController();
  const upstreamSignal = options?.signal;
  let rejectAbort;
  const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = (code, message) => {
    if (controller.signal.aborted) return;
    const error = Object.assign(new Error(message), { code });
    controller.abort(error);
    rejectAbort(error);
  };
  const onUpstreamAbort = () => abort('RPC_ABORTED', 'RPC request cancelled');
  const timer = setTimeout(() => abort('RPC_TIMEOUT', `RPC request timeout after ${timeoutMs}ms`), timeoutMs);
  upstreamSignal?.addEventListener('abort', onUpstreamAbort, { once: true });
  let response;
  let consumed = false;
  try {
    if (upstreamSignal?.aborted) onUpstreamAbort();
    const operation = (async () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      response = await (config.fetchImpl || globalThis.fetch)(url, { ...options, signal: controller.signal });
      if (controller.signal.aborted) {
        // A custom fetch implementation may settle after the race has already
        // timed out. The outer finally ran before this response existed.
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
        throw controller.signal.reason;
      }
      const result = await consume(response);
      if (controller.signal.aborted) throw controller.signal.reason;
      consumed = true;
      return result;
    })();
    return await Promise.race([operation, interrupted]);
  } catch (error) {
    throw transportError(error);
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', onUpstreamAbort);
    if (!consumed && response?.body && !response.body.locked) {
      // Dispose of a refused/unconsumed response without letting cleanup stall
      // the fallback. Native fetch's abort signal also cancels active readers.
      void response.body.cancel().catch(() => {});
    }
  }
}

async function readRpcResponse(url, options = {}, config = {}) {
  return withRpcResponse(url, options, async (response) => {
    // Native responses always expose text(). The json-only branch preserves
    // compatibility with injected readers used by the offline test suites.
    const body = typeof response.text === 'function'
      ? await response.text()
      : JSON.stringify(await response.json());
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText || '',
      headers: response.headers || new Headers(),
      text: async () => body,
      json: async () => {
        try { return JSON.parse(body); }
        catch { throw Object.assign(new Error('Invalid JSON RPC response'), { code: 'RPC_INVALID_RESPONSE' }); }
      },
    };
  }, config);
}

function isCooldownFailure(error) {
  const status = Number(error?.status);
  if (status >= 500 && status <= 599) return true;
  const code = String(error?.code || error?.cause?.code || '');
  if (/^(?:RPC_HTTP_5\d\d|RPC_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_.*TIMEOUT|UND_ERR_SOCKET)$/.test(code)) return true;
  return /fetch failed|network error|socket hang up|request timeout/i.test(String(error?.message || error || ''));
}

function createProviderCooldowns(options = {}) {
  const now = options.now || Date.now;
  const cooldownMs = positiveBounded(options.cooldownMs ?? process.env.RPC_PROVIDER_COOLDOWN_MS, DEFAULT_COOLDOWN_MS, 300000);
  const until = new Map();
  const key = (url, method) => `${method} ${url}`;
  return {
    order(urls, method) {
      const unique = [...new Set(urls)];
      const orderedAt = now();
      // Prefer healthy providers, but retain cooling alternatives at the end.
      // They are reached only if healthier alternatives fail. This avoids
      // removing the sole recovering provider from a request's fallback path.
      return unique.filter((url) => (until.get(key(url, method)) || 0) <= orderedAt)
        .concat(unique.filter((url) => (until.get(key(url, method)) || 0) > orderedAt)
          .sort((a, b) => until.get(key(a, method)) - until.get(key(b, method))));
    },
    failed(url, method, error) {
      if (isCooldownFailure(error)) until.set(key(url, method), now() + cooldownMs);
    },
    succeeded(url, method) { until.delete(key(url, method)); },
    clear() { until.clear(); },
  };
}

module.exports = { withRpcResponse, readRpcResponse, sanitizeRpcMessage, createProviderCooldowns, isCooldownFailure };
