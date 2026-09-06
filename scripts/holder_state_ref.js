// Repository-scoped CI persistence. Importing this module never loads RPC credentials.
// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STATE_REF = 'refs/data-state';
const LOCAL_REF = 'refs/remotes/origin/holder-state-restore';
const STATE_NAME = 'holder_rankings_state.json';
const WRITER_BRANCH = 'main';
const MAX_ATTEMPTS = 3;
const SHA = /^[a-f0-9]{40}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const BLOCK_HASH = /^0x[0-9a-f]{64}$/i;
const CHAINS = new Set(['ethereum', 'base', 'polygon']);

class HolderStateRefError extends Error {
  /** @param {string} code */
  constructor(code) { super(code); this.code = code; }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is number} */
function isBlockNumber(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

/** @param {unknown} value @param {unknown} checkpoint */
function validateReorgState(value, checkpoint) {
  const invalid = () => { throw new HolderStateRefError('holder-state-invalid-reorg'); };
  if (!isRecord(value) || (value.phase !== 'canonical' && value.phase !== 'tail')) return invalid();
  const anchor = value.anchor;
  if (anchor !== null) {
    if (!isRecord(anchor) || !isBlockNumber(anchor.blockNumber) || typeof anchor.blockHash !== 'string'
      || !BLOCK_HASH.test(anchor.blockHash) || !isRecord(anchor.balances) || !isBlockNumber(anchor.processedLogCount)
      || !Array.isArray(anchor.pendingBalanceReconcile)
      || anchor.pendingBalanceReconcile.some((address) => typeof address !== 'string' || !ADDRESS.test(address))) return invalid();
    for (const [address, balance] of Object.entries(anchor.balances)) {
      if (!/^0x[0-9a-f]{40}$/.test(address) || typeof balance !== 'string' || !/^[1-9]\d*$/.test(balance)) return invalid();
    }
    if (isBlockNumber(checkpoint) && checkpoint < anchor.blockNumber) return invalid();
  }
  if (value.phase === 'tail' && (anchor === null || !isBlockNumber(checkpoint))) return invalid();
  const target = value.canonicalTarget;
  if (value.phase === 'canonical' || target !== undefined) {
    if (!isRecord(target) || !isBlockNumber(target.blockNumber) || typeof target.blockHash !== 'string' || !BLOCK_HASH.test(target.blockHash)) return invalid();
    if (isRecord(anchor) && isBlockNumber(anchor.blockNumber) && target.blockNumber < anchor.blockNumber) return invalid();
    if (value.phase === 'canonical' && isBlockNumber(checkpoint) && checkpoint > target.blockNumber) return invalid();
  }
}

/** Reject malformed state before the updater's permissive normalizer can rebuild it.
 * Negative raw balances are legitimate while exact-block reconciliation is queued.
 * @param {string} text
 */
function validateHolderState(text) {
  let state;
  try { state = JSON.parse(text); } catch { throw new HolderStateRefError('holder-state-invalid-json'); }
  const invalid = () => { throw new HolderStateRefError('holder-state-invalid-schema'); };
  // v1 is a supported input to the updater's existing explicit migration;
  // restore validation must not introduce a new barrier to that migration.
  if (!isRecord(state) || (state.version !== 1 && state.version !== 2) || !isRecord(state.chains) || !isRecord(state.holders)) return invalid();
  if (state.updatedAt !== null && (typeof state.updatedAt !== 'string' || !Number.isFinite(Date.parse(state.updatedAt)))) return invalid();
  for (const [chain, value] of Object.entries(state.chains)) {
    if (!CHAINS.has(chain) || !isRecord(value) || typeof value.tokenAddress !== 'string' || !ADDRESS.test(value.tokenAddress)) return invalid();
    if (typeof value.decimals !== 'number' || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) return invalid();
    for (const key of ['lastScannedBlock', 'contractStartBlock', 'latestBlockAtRun', 'processedLogCount']) {
      if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0)) return invalid();
    }
    if (value.pendingBalanceReconcile !== undefined && (!Array.isArray(value.pendingBalanceReconcile)
      || value.pendingBalanceReconcile.some((address) => typeof address !== 'string' || !ADDRESS.test(address)))) return invalid();
    if (value.reorg !== undefined) validateReorgState(value.reorg, value.lastScannedBlock);
  }
  for (const [address, balances] of Object.entries(state.holders)) {
    if (!ADDRESS.test(address) || !isRecord(balances)) return invalid();
    for (const [chain, balance] of Object.entries(balances)) {
      if (!CHAINS.has(chain) || !Object.hasOwn(state.chains, chain) || typeof balance !== 'string' || !/^-?\d+$/.test(balance)) return invalid();
    }
  }
  return state;
}

/** @typedef {{ code: number, stdout: string }} GitResult */
/** @typedef {(args: string[], input?: string) => Promise<GitResult>} Git */
/** @typedef {(ms: number) => Promise<void>} Sleep */
/** @type {Sleep} */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bound every subprocess and suppress raw Git output, which can contain credential URLs.
 * @type {Git}
 */
async function runGit(args, input) {
  const result = spawnSync('git', args, {
    // Even the longest path (three writes plus nine remote checks) fits the
    // workflow's three-minute persistence step: at most 162s including backoff.
    input, encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  return { code: result.error ? -1 : result.status ?? -1, stdout: result.stdout || '' };
}

/** @param {Git} git @param {string[]} args @param {string} failure @param {string} [input] */
async function checkedGit(git, args, failure, input) {
  const result = await git(args, input);
  if (result.code !== 0) throw new HolderStateRefError(failure);
  return result.stdout.trim();
}

/** Exit 2 from ls-remote --exit-code is the only accepted evidence of absence.
 * @param {Git} git @param {Sleep} pause
 * @returns {Promise<string | null>}
 */
async function readRemoteStateRef(git, pause) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await git(['ls-remote', '--exit-code', '--refs', 'origin', STATE_REF]);
    if (result.code === 2 && !result.stdout.trim()) return null;
    if (result.code === 0) {
      const match = /^([a-f0-9]{40})\s+refs\/data-state$/.exec(result.stdout.trim());
      if (!match) throw new HolderStateRefError('holder-state-ref-invalid');
      return match[1];
    }
    if (attempt < MAX_ATTEMPTS) await pause(attempt * 1000);
  }
  throw new HolderStateRefError('holder-state-ref-unavailable');
}

/** @param {{ branch: string, bootstrap?: boolean, git?: Git, pause?: Sleep }} options */
async function restoreHolderStateRef({ branch, bootstrap = false, git = runGit, pause = sleep }) {
  if (branch !== WRITER_BRANCH) return { ready: false, reason: 'holder-state-main-only' };
  const remote = await readRemoteStateRef(git, pause);
  if (remote === null) {
    if (!bootstrap) throw new HolderStateRefError('holder-state-bootstrap-required');
    return {
      ready: true, reason: 'holder-state-bootstrap', expectedSha: '', bootstrap: true,
      stateText: `${JSON.stringify({ version: 2, updatedAt: null, chains: {}, holders: {} })}\n`,
    };
  }
  let fetched = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await git(['fetch', '--no-tags', '--depth=1', 'origin', `+${STATE_REF}:${LOCAL_REF}`]);
    if (result.code === 0) { fetched = true; break; }
    if (attempt < MAX_ATTEMPTS) await pause(attempt * 1000);
  }
  if (!fetched) throw new HolderStateRefError('holder-state-fetch-failed');
  // Use the exact fetched revision as the subsequent write lease; the remote
  // may have advanced between ls-remote and fetch.
  const expectedSha = await checkedGit(git, ['rev-parse', '--verify', LOCAL_REF], 'holder-state-revision-failed');
  if (!SHA.test(expectedSha)) throw new HolderStateRefError('holder-state-ref-invalid');
  const stateText = await checkedGit(git, ['cat-file', '-p', `${expectedSha}:${STATE_NAME}`], 'holder-state-read-failed');
  validateHolderState(stateText);
  return { ready: true, reason: 'holder-state-restored', expectedSha, bootstrap: false, stateText: `${stateText}\n` };
}

/** @param {{ branch: string, expectedSha: string, bootstrap?: boolean, stateText: string, git?: Git, pause?: Sleep }} options */
async function persistHolderStateRef({ branch, expectedSha, bootstrap = false, stateText, git = runGit, pause = sleep }) {
  if (branch !== WRITER_BRANCH) throw new HolderStateRefError('holder-state-main-only');
  if (!(SHA.test(expectedSha) || (expectedSha === '' && bootstrap))) throw new HolderStateRefError('holder-state-lease-required');
  validateHolderState(stateText);
  const blob = await checkedGit(git, ['hash-object', '-w', '--stdin'], 'holder-state-blob-failed', stateText);
  if (!SHA.test(blob)) throw new HolderStateRefError('holder-state-object-invalid');
  const tree = await checkedGit(git, ['mktree'], 'holder-state-tree-failed', `100644 blob ${blob}\t${STATE_NAME}\n`);
  if (!SHA.test(tree)) throw new HolderStateRefError('holder-state-object-invalid');
  const commit = await checkedGit(git, [
    '-c', 'user.name=github-actions[bot]', '-c', 'user.email=github-actions[bot]@users.noreply.github.com',
    'commit-tree', tree, '-m', 'holder rankings state',
  ], 'holder-state-commit-failed');
  if (!SHA.test(commit)) throw new HolderStateRefError('holder-state-object-invalid');
  // Build once and reuse the identical commit/lease on every retry. A lost
  // success response must never cause a replacement commit or an unconditional push.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await git(['push', `--force-with-lease=${STATE_REF}:${expectedSha}`, 'origin', `${commit}:${STATE_REF}`]);
    if (result.code === 0) return { reason: 'holder-state-persisted', commit };
    const remote = await readRemoteStateRef(git, pause);
    if (remote === commit) return { reason: 'holder-state-persisted', commit };
    if ((remote ?? '') !== expectedSha) throw new HolderStateRefError('holder-state-lease-conflict');
    if (attempt < MAX_ATTEMPTS) await pause(attempt * 1000);
  }
  throw new HolderStateRefError('holder-state-push-failed');
}

async function main() {
  const branch = process.env.GITHUB_REF_NAME || '';
  const statePath = path.join(__dirname, '..', 'data', STATE_NAME);
  if (process.argv[2] === 'restore') {
    const bootstrap = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
      && process.env.HOLDER_STATE_BOOTSTRAP === 'true' && process.env.DASHBOARD_WATCHDOG !== 'true';
    const result = await restoreHolderStateRef({ branch, bootstrap });
    if (result.ready) {
      if (!process.env.GITHUB_OUTPUT) throw new HolderStateRefError('holder-state-output-missing');
      if (typeof result.stateText !== 'string') throw new HolderStateRefError('holder-state-restore-incomplete');
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(`${statePath}.tmp`, result.stateText);
      fs.renameSync(`${statePath}.tmp`, statePath);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `ready=true\nexpected_sha=${result.expectedSha}\nbootstrap=${result.bootstrap}\n`);
    }
    console.log(result.reason);
  } else if (process.argv[2] === 'persist') {
    if (process.env.HOLDER_STATE_READY !== 'true') throw new HolderStateRefError('holder-state-restore-required');
    const result = await persistHolderStateRef({
      branch, expectedSha: process.env.HOLDER_STATE_EXPECTED_SHA || '',
      bootstrap: process.env.HOLDER_STATE_BOOTSTRAP === 'true', stateText: fs.readFileSync(statePath, 'utf8'),
    });
    console.log(`${result.reason} (${result.commit})`);
  } else throw new HolderStateRefError('holder-state-command-invalid');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`::error::${error instanceof HolderStateRefError ? error.code : 'holder-state-operation-failed'}`);
    process.exitCode = 1;
  });
}

module.exports = { validateHolderState, readRemoteStateRef, restoreHolderStateRef, persistHolderStateRef };
