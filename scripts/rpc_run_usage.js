const fs = require('fs');
const path = require('path');

// Current Alchemy EVM/Transfers method costs. These weights are used for
// pacing and conservative run telemetry only; they never affect RPC results.
const ALCHEMY_COMPUTE_UNITS = Object.freeze({
  eth_blockNumber: 10,
  eth_getBlockByNumber: 20,
  eth_getCode: 20,
  eth_call: 26,
  eth_getLogs: 60,
  alchemy_getAssetTransfers: 120,
});

const DEFAULT_UNKNOWN_ALCHEMY_COMPUTE_UNITS = 120;
const DEFAULT_ALCHEMY_TARGET_CUPS = 600;
const DEFAULT_ALCHEMY_MIN_INTERVAL_MS = 20;
const DEFAULT_PROVIDER_MIN_INTERVAL_MS = 100;
const TELEMETRY_SCOPE = ['poolVolume', 'holderRankings'];
const TELEMETRY_EXCLUSIONS = ['chainstackKeepalive', 'onchainSnapshot', 'vercelLiveFallback'];

function finiteNonNegativeOr(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function finitePositiveOr(value, fallback) {
  const parsed = finiteNonNegativeOr(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function getRpcProviderLabel(url) {
  let host = '';
  try {
    host = new URL(String(url || '')).host.toLowerCase();
  } catch {
    return 'unknown';
  }

  if (host.endsWith('.alchemy.com')) return 'alchemy';
  if (host.endsWith('.infura.io')) return 'infura';
  if (host.includes('chainstack')) return 'chainstack';
  return host || 'unknown';
}

function getAlchemyComputeUnits(method) {
  const normalizedMethod = String(method || 'unknown');
  const known = Object.prototype.hasOwnProperty.call(ALCHEMY_COMPUTE_UNITS, normalizedMethod);
  return {
    computeUnits: known
      ? ALCHEMY_COMPUTE_UNITS[normalizedMethod]
      : DEFAULT_UNKNOWN_ALCHEMY_COMPUTE_UNITS,
    known,
  };
}

function getPacingSettings(env = process.env) {
  const hasLegacyOverride = Object.prototype.hasOwnProperty.call(env, 'RPC_MIN_INTERVAL_MS') &&
    String(env.RPC_MIN_INTERVAL_MS ?? '').trim() !== '' &&
    Number.isFinite(Number(env.RPC_MIN_INTERVAL_MS)) &&
    Number(env.RPC_MIN_INTERVAL_MS) >= 0;

  return {
    legacyOverrideMs: hasLegacyOverride ? Number(env.RPC_MIN_INTERVAL_MS) : null,
    alchemyTargetCups: finitePositiveOr(
      env.RPC_ALCHEMY_TARGET_CUPS,
      DEFAULT_ALCHEMY_TARGET_CUPS,
    ),
    alchemyMinIntervalMs: finiteNonNegativeOr(
      env.RPC_ALCHEMY_MIN_INTERVAL_MS,
      DEFAULT_ALCHEMY_MIN_INTERVAL_MS,
    ),
    providerMinIntervalMs: DEFAULT_PROVIDER_MIN_INTERVAL_MS,
  };
}

function getRpcPacingGapMs(url, method, env = process.env) {
  const settings = getPacingSettings(env);
  if (settings.legacyOverrideMs != null) return settings.legacyOverrideMs;
  if (getRpcProviderLabel(url) !== 'alchemy') return settings.providerMinIntervalMs;

  const { computeUnits } = getAlchemyComputeUnits(method);
  return Math.max(
    settings.alchemyMinIntervalMs,
    Math.ceil((computeUnits / settings.alchemyTargetCups) * 1000),
  );
}

function createRpcRunUsageTracker(options = {}) {
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let nextAllowedAt = new Map();
  let providers = new Map();

  function reserveAttempt(url, method) {
    const provider = getRpcProviderLabel(url);
    const gapMs = getRpcPacingGapMs(url, method, env);
    const nowMs = Number(now());

    if (!(gapMs > 0)) {
      nextAllowedAt.set(provider, nowMs);
      return { provider, method: String(method || 'unknown'), gapMs: 0, waitMs: 0, scheduledAt: nowMs };
    }

    // Reserve synchronously before awaiting. Concurrent callers therefore
    // cannot observe and claim the same provider slot.
    const scheduledAt = Math.max(nowMs, nextAllowedAt.get(provider) || nowMs);
    nextAllowedAt.set(provider, scheduledAt + gapMs);
    return {
      provider,
      method: String(method || 'unknown'),
      gapMs,
      waitMs: Math.max(0, scheduledAt - nowMs),
      scheduledAt,
    };
  }

  function recordAttempt(url, method, waitMs = 0) {
    const provider = getRpcProviderLabel(url);
    const normalizedMethod = String(method || 'unknown');
    let providerUsage = providers.get(provider);
    if (!providerUsage) {
      providerUsage = {
        requestCount: 0,
        pacingWaitMs: 0,
        estimatedComputeUnitsUpperBound: 0,
        methods: new Map(),
        unknownAlchemyMethods: new Set(),
      };
      providers.set(provider, providerUsage);
    }

    providerUsage.requestCount += 1;
    providerUsage.pacingWaitMs += Math.max(0, Number(waitMs) || 0);

    let methodUsage = providerUsage.methods.get(normalizedMethod);
    if (!methodUsage) {
      methodUsage = { requestCount: 0, estimatedComputeUnitsUpperBound: 0 };
      providerUsage.methods.set(normalizedMethod, methodUsage);
    }
    methodUsage.requestCount += 1;

    if (provider === 'alchemy') {
      const { computeUnits, known } = getAlchemyComputeUnits(normalizedMethod);
      providerUsage.estimatedComputeUnitsUpperBound += computeUnits;
      methodUsage.estimatedComputeUnitsUpperBound += computeUnits;
      if (!known) providerUsage.unknownAlchemyMethods.add(normalizedMethod);
    }
  }

  async function beforeAttempt(url, method) {
    const reservation = reserveAttempt(url, method);
    if (reservation.waitMs > 0) await sleep(reservation.waitMs);
    recordAttempt(url, method, reservation.waitMs);
    return reservation;
  }

  function snapshot() {
    const providerEntries = {};
    let requestCount = 0;
    let pacingWaitMs = 0;
    let estimatedAlchemyComputeUnitsUpperBound = 0;
    const unknownAlchemyMethods = new Set();

    for (const provider of Array.from(providers.keys()).sort()) {
      const usage = providers.get(provider);
      const methods = {};
      for (const method of Array.from(usage.methods.keys()).sort()) {
        methods[method] = { ...usage.methods.get(method) };
      }

      const providerSnapshot = {
        requestCount: usage.requestCount,
        pacingWaitMs: usage.pacingWaitMs,
        methods,
      };
      if (provider === 'alchemy') {
        providerSnapshot.estimatedComputeUnitsUpperBound = usage.estimatedComputeUnitsUpperBound;
        providerSnapshot.unknownMethods = Array.from(usage.unknownAlchemyMethods).sort();
        estimatedAlchemyComputeUnitsUpperBound += usage.estimatedComputeUnitsUpperBound;
        for (const method of usage.unknownAlchemyMethods) unknownAlchemyMethods.add(method);
      }

      providerEntries[provider] = providerSnapshot;
      requestCount += usage.requestCount;
      pacingWaitMs += usage.pacingWaitMs;
    }

    return {
      requestCount,
      pacingWaitMs,
      estimatedAlchemyComputeUnitsUpperBound,
      unknownAlchemyMethods: Array.from(unknownAlchemyMethods).sort(),
      pacing: getPacingSettings(env),
      providers: providerEntries,
    };
  }

  function reset() {
    nextAllowedAt = new Map();
    providers = new Map();
  }

  return { beforeAttempt, reserveAttempt, recordAttempt, snapshot, reset };
}

function getRpcUsageRunId(env = process.env) {
  if (String(env.RPC_USAGE_RUN_ID || '').trim()) return String(env.RPC_USAGE_RUN_ID).trim();
  if (String(env.GITHUB_RUN_ID || '').trim()) {
    return `${String(env.GITHUB_RUN_ID).trim()}-${String(env.GITHUB_RUN_ATTEMPT || '1').trim()}`;
  }
  return 'local';
}

function writeRpcUsageComponent(filePath, component, runId, usage, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const nowIso = options.nowIso || (() => new Date().toISOString());
  const warn = options.warn || ((message) => console.warn(message));
  let tempFile = null;

  try {
    let payload = null;
    if (!options.reset) {
      try {
        payload = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      } catch {
        payload = null;
      }
    }

    if (!payload || payload.runId !== runId || !payload.components || typeof payload.components !== 'object') {
      payload = {
        version: 1,
        runId,
        scope: TELEMETRY_SCOPE,
        exclusions: TELEMETRY_EXCLUSIONS,
        components: {},
      };
    }

    payload.components[component] = { ...usage, recordedAt: nowIso() };
    const componentValues = Object.values(payload.components);
    payload.totals = {
      requestCount: componentValues.reduce((sum, value) => sum + Number(value.requestCount || 0), 0),
      pacingWaitMs: componentValues.reduce((sum, value) => sum + Number(value.pacingWaitMs || 0), 0),
      estimatedAlchemyComputeUnitsUpperBound: componentValues.reduce(
        (sum, value) => sum + Number(value.estimatedAlchemyComputeUnitsUpperBound || 0),
        0,
      ),
    };
    payload.updatedAt = nowIso();

    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fsImpl.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`);
    fsImpl.renameSync(tempFile, filePath);
    return true;
  } catch (error) {
    if (tempFile) {
      try {
        fsImpl.unlinkSync(tempFile);
      } catch {
        // best-effort cleanup only
      }
    }
    warn(`[rpc-usage] Unable to write ${component} telemetry: ${error && error.message ? error.message : String(error)}`);
    return false;
  }
}

module.exports = {
  ALCHEMY_COMPUTE_UNITS,
  DEFAULT_UNKNOWN_ALCHEMY_COMPUTE_UNITS,
  getRpcProviderLabel,
  getAlchemyComputeUnits,
  getPacingSettings,
  getRpcPacingGapMs,
  createRpcRunUsageTracker,
  getRpcUsageRunId,
  writeRpcUsageComponent,
};
