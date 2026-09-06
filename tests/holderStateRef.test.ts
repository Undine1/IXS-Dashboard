import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { persistHolderStateRef, restoreHolderStateRef, validateHolderState } from '../scripts/holder_state_ref';

const original = 'a'.repeat(40);
const blob = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const commit = 'd'.repeat(40);
const anotherWriter = 'e'.repeat(40);
const token = `0x${'1'.repeat(40)}`;
const holder = `0x${'2'.repeat(40)}`;
const state = () => ({
  version: 2,
  updatedAt: '2026-09-06T10:00:00Z',
  chains: { ethereum: { tokenAddress: token, decimals: 18, lastScannedBlock: 123, pendingBalanceReconcile: [holder] } },
  holders: { [holder]: { ethereum: '-1234567890' } },
});
const stateText = () => JSON.stringify(state());
const ok = (stdout = '') => ({ code: 0, stdout });
const remote = (sha = original) => ok(`${sha}\trefs/data-state\n`);
const unavailable = { code: 128, stdout: '' };
const absent = { code: 2, stdout: '' };

function fakeGit(results: Array<{ code: number; stdout: string }>) {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const waits: number[] = [];
  return {
    calls, waits,
    git: async (args: string[], input?: string) => {
      calls.push({ args, input });
      assert.ok(results.length, `unexpected Git command: ${args[0]}`);
      return results.shift()!;
    },
    pause: async (ms: number) => { waits.push(ms); },
  };
}

test('holder state restore distinguishes inaccessible remote from explicitly missing ref', async () => {
  for (const bootstrap of [false, true]) {
    const git = fakeGit([unavailable, unavailable, unavailable]);
    await assert.rejects(restoreHolderStateRef({ branch: 'main', bootstrap, ...git }), /holder-state-ref-unavailable/);
    assert.equal(git.calls.length, 3);
    assert.ok(git.calls.every(({ args }) => args[0] === 'ls-remote'));
    assert.deepEqual(git.waits, [1000, 2000]);
  }
  await assert.rejects(restoreHolderStateRef({ branch: 'main', ...fakeGit([absent]) }), /holder-state-bootstrap-required/);
  const bootstrapped = await restoreHolderStateRef({ branch: 'main', bootstrap: true, ...fakeGit([absent]) });
  assert.equal(bootstrapped.ready, true);
  assert.equal(bootstrapped.expectedSha, '');
  assert.equal(bootstrapped.bootstrap, true);
  assert.deepEqual(JSON.parse(bootstrapped.stateText!), { version: 2, updatedAt: null, chains: {}, holders: {} });
});

test('successful but ambiguous ref metadata never authorizes bootstrap', async () => {
  for (const result of [ok(''), ok('unexpected ref'), { code: 2, stdout: 'unexpected content' }]) {
    const git = fakeGit(result.code === 2 ? [result, result, result] : [result]);
    await assert.rejects(restoreHolderStateRef({ branch: 'main', bootstrap: true, ...git }), /holder-state-ref-(invalid|unavailable)/);
    assert.ok(git.calls.every(({ args }) => args[0] === 'ls-remote'));
  }
});

test('transient lookup/fetch errors retry and lease the actual fetched revision', async () => {
  const git = fakeGit([unavailable, remote(), unavailable, ok(), ok(anotherWriter), ok(stateText())]);
  const result = await restoreHolderStateRef({ branch: 'main', bootstrap: true, ...git });
  assert.equal(result.expectedSha, anotherWriter);
  assert.equal(result.bootstrap, false, 'explicit bootstrap must never discard an existing ref');
  assert.deepEqual(JSON.parse(result.stateText!), state());
  assert.deepEqual(git.calls.at(-1)?.args, ['cat-file', '-p', `${anotherWriter}:holder_rankings_state.json`]);
  assert.equal(git.calls.filter(({ args }) => args[0] === 'fetch').length, 2);
});

test('exhausted fetch does not fall back to a historical bootstrap', async () => {
  const git = fakeGit([remote(), unavailable, unavailable, unavailable]);
  await assert.rejects(restoreHolderStateRef({ branch: 'main', bootstrap: true, ...git }), /holder-state-fetch-failed/);
  assert.equal(git.calls.filter(({ args }) => args[0] === 'fetch').length, 3);
  assert.ok(!git.calls.some(({ args }) => args[0] === 'cat-file'));
});

test('state validation rejects corrupt schema and accepts pending signed balances', () => {
  assert.deepEqual(validateHolderState(stateText()), state());
  assert.equal(validateHolderState(JSON.stringify({ ...state(), version: 1 })).version, 1);
  assert.throws(() => validateHolderState('{'), /holder-state-invalid-json/);
  const invalidStates: unknown[] = [
    {}, [], { ...state(), version: 0 }, { ...state(), version: 3 },
    { ...state(), chains: [] }, { ...state(), holders: [] }, { ...state(), updatedAt: 'bad' },
    { ...state(), chains: { ethereum: { ...state().chains.ethereum, lastScannedBlock: -1 } } },
    { ...state(), chains: { ethereum: { ...state().chains.ethereum, lastScannedBlock: 1.5 } } },
    { ...state(), chains: { ethereum: { ...state().chains.ethereum, lastScannedBlock: '123' } } },
    { ...state(), chains: { ethereum: { ...state().chains.ethereum, tokenAddress: 'invalid' } } },
    { ...state(), chains: { ethereum: { ...state().chains.ethereum, pendingBalanceReconcile: ['invalid'] } } },
    { ...state(), holders: { [holder]: { ethereum: '1.25' } } },
    { ...state(), holders: { [holder]: { ethereum: 125 } } },
    { ...state(), holders: { [holder]: { base: '125' } } },
  ];
  for (const value of invalidStates) assert.throws(() => validateHolderState(JSON.stringify(value)), /holder-state-invalid-schema/);
});

test('invalid restored state stops before admitting holder work', async () => {
  for (const text of ['not JSON', '{}']) {
    const git = fakeGit([remote(), ok(), ok(original), ok(text)]);
    await assert.rejects(restoreHolderStateRef({ branch: 'main', ...git }), /holder-state-invalid/);
    assert.equal(git.calls.length, 4);
  }
});

test('optional holder reorg baselines are validated instead of treated as legacy state', () => {
  const anchor = {
    blockNumber: 100, blockHash: `0x${'f'.repeat(64)}`,
    balances: { [holder]: '123' }, pendingBalanceReconcile: [], processedLogCount: 12,
  };
  const canonicalTarget = { blockNumber: 150, blockHash: `0x${'a'.repeat(64)}` };
  const withReorg = (reorg: unknown) => JSON.stringify({
    ...state(), chains: { ethereum: { ...state().chains.ethereum, reorg } },
  });
  for (const reorg of [
    { anchor, phase: 'tail' }, { anchor, phase: 'canonical', canonicalTarget },
    { anchor: null, phase: 'canonical', canonicalTarget },
  ]) assert.doesNotThrow(() => validateHolderState(withReorg(reorg)));
  for (const reorg of [
    null, {}, { phase: 'tail' }, { anchor: null, phase: 'tail' }, { anchor, phase: 'canonical' },
    { anchor, phase: 'canonical', canonicalTarget: { ...canonicalTarget, blockNumber: 122 } },
    { anchor, phase: 'canonical', canonicalTarget: { ...canonicalTarget, blockNumber: 99 } },
    { anchor: { ...anchor, blockNumber: 124 }, phase: 'tail' },
    { anchor: { ...anchor, blockHash: 'bad' }, phase: 'tail' },
    { anchor: { ...anchor, balances: { [holder]: '-1' } }, phase: 'tail' },
    { anchor: { ...anchor, pendingBalanceReconcile: ['bad'] }, phase: 'tail' },
  ]) assert.throws(() => validateHolderState(withReorg(reorg)), /holder-state-invalid-reorg/);
});

test('non-main branches cannot restore or overwrite shared production state', async () => {
  const git = fakeGit([]);
  assert.deepEqual(await restoreHolderStateRef({ branch: 'codex/test', bootstrap: true, ...git }), {
    ready: false, reason: 'holder-state-main-only',
  });
  await assert.rejects(persistHolderStateRef({ branch: 'codex/test', expectedSha: original, stateText: stateText(), ...git }), /holder-state-main-only/);
  assert.equal(git.calls.length, 0);
});

test('state persistence requires a valid restore lease and valid replacement state', async () => {
  const git = fakeGit([]);
  for (const expectedSha of ['', 'not-a-sha']) {
    await assert.rejects(persistHolderStateRef({ branch: 'main', expectedSha, stateText: stateText(), ...git }), /holder-state-lease-required/);
  }
  await assert.rejects(persistHolderStateRef({ branch: 'main', expectedSha: original, stateText: '{}', ...git }), /holder-state-invalid-schema/);
  assert.equal(git.calls.length, 0);
});

test('persistence uses the restored lease and keeps exact state bytes in one orphan commit', async () => {
  const git = fakeGit([ok(blob), ok(tree), ok(commit), ok()]);
  const result = await persistHolderStateRef({ branch: 'main', expectedSha: original, stateText: stateText(), ...git });
  assert.equal(result.commit, commit);
  assert.equal(git.calls[0].input, stateText());
  assert.equal(git.calls[1].input, `100644 blob ${blob}\tholder_rankings_state.json\n`);
  assert.ok(git.calls[2].args.includes('commit-tree'));
  assert.ok(!git.calls[2].args.includes('-p'), 'state commit stays parentless');
  assert.deepEqual(git.calls[3].args, ['push', `--force-with-lease=refs/data-state:${original}`, 'origin', `${commit}:refs/data-state`]);
});

test('lease conflict aborts instead of overwriting another writer', async () => {
  const git = fakeGit([ok(blob), ok(tree), ok(commit), unavailable, remote(anotherWriter)]);
  await assert.rejects(persistHolderStateRef({ branch: 'main', expectedSha: original, stateText: stateText(), ...git }), /holder-state-lease-conflict/);
  assert.equal(git.calls.filter(({ args }) => args[0] === 'push').length, 1);
});

test('lost push receipt recognizes the exact commit without another mutation', async () => {
  const git = fakeGit([ok(blob), ok(tree), ok(commit), unavailable, remote(commit)]);
  const result = await persistHolderStateRef({ branch: 'main', expectedSha: original, stateText: stateText(), ...git });
  assert.equal(result.commit, commit);
  assert.equal(git.calls.filter(({ args }) => args[0] === 'push').length, 1);
});

test('transient push failures reuse the same commit and lease, with bounded attempts', async () => {
  const git = fakeGit([ok(blob), ok(tree), ok(commit), unavailable, remote(), unavailable, remote(), unavailable, remote()]);
  await assert.rejects(persistHolderStateRef({ branch: 'main', expectedSha: original, stateText: stateText(), ...git }), /holder-state-push-failed/);
  const pushes = git.calls.filter(({ args }) => args[0] === 'push');
  assert.equal(pushes.length, 3);
  for (const push of pushes) assert.deepEqual(push, pushes[0]);
  assert.equal(git.calls.filter(({ args }) => args.includes('commit-tree')).length, 1);
});

test('uncertain push plus unavailable remote stops without another push', async () => {
  const git = fakeGit([ok(blob), ok(tree), ok(commit), unavailable, unavailable, unavailable, unavailable]);
  await assert.rejects(persistHolderStateRef({ branch: 'main', expectedSha: original, stateText: stateText(), ...git }), /holder-state-ref-unavailable/);
  assert.equal(git.calls.filter(({ args }) => args[0] === 'push').length, 1);
});

test('bootstrap uses a missing-ref lease and cannot replace a concurrently created ref', async () => {
  const git = fakeGit([ok(blob), ok(tree), ok(commit), unavailable, remote(anotherWriter)]);
  await assert.rejects(persistHolderStateRef({ branch: 'main', expectedSha: '', bootstrap: true, stateText: stateText(), ...git }), /holder-state-lease-conflict/);
  assert.ok(git.calls.find(({ args }) => args[0] === 'push')?.args.includes('--force-with-lease=refs/data-state:'));
});

test('workflow reserves persistence time and gates holders without blocking independent products', () => {
  const workflow = readFileSync('.github/workflows/update-dashboard-data.yml', 'utf8');
  const jobTimeout = Number(workflow.match(/^    timeout-minutes: (\d+)$/m)?.[1]);
  const stepTimeouts = [...workflow.matchAll(/^        timeout-minutes: (\d+)$/gm)].map((match) => Number(match[1]));
  assert.ok(stepTimeouts.reduce((total, value) => total + value, 0) < jobTimeout);
  const step = (name: string) => workflow.split(`- name: ${name}\n`)[1]?.split('\n      - name:')[0] || '';
  assert.ok(step('Restore holder rankings state').includes('id: holder_state'));
  assert.ok(step('Run holder rankings updater').includes("steps.holder_state.outputs.ready == 'true'"));
  assert.ok(step('Persist holder rankings state').includes('HOLDER_STATE_EXPECTED_SHA:'));
  for (const name of ['Update on-chain snapshot', 'Commit updated data files', 'Upload run artifacts']) {
    assert.ok(step(name).includes('!cancelled()'));
    assert.ok(!step(name).includes('steps.holder_state.outputs.ready'));
  }
  for (const [name, budget] of [['Run pool updater', 1020000], ['Run holder rankings updater', 1920000]] as const) {
    const contents = step(name);
    assert.ok(contents.includes(`RPC_RUN_BUDGET_MS: '${budget}'`));
    assert.ok(contents.includes('RPC_ALCHEMY_BUDGET_CUPS:'));
    assert.ok(budget < Number(contents.match(/timeout-minutes: (\d+)/)?.[1]) * 60_000);
  }
  assert.ok(workflow.includes('bootstrap_holder_state:'));
  assert.ok(!workflow.includes('git push -f origin'));
});
