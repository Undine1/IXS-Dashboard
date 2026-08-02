import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import rpcRunUsageModule from '../scripts/rpc_run_usage.js';

const {
  getRpcProviderLabel,
  getAlchemyComputeUnits,
  getRpcPacingGapMs,
  createRpcRunUsageTracker,
  writeRpcUsageComponent,
} = rpcRunUsageModule;

const ALCHEMY_ETH = 'https://eth-mainnet.g.alchemy.com/v2/secret-key';
const ALCHEMY_BASE = 'https://base-mainnet.g.alchemy.com/v2/secret-key';
const INFURA = 'https://mainnet.infura.io/v3/secret-key';

test('provider labels group shared credentials without exposing URL secrets', () => {
  assert.equal(getRpcProviderLabel(ALCHEMY_ETH), 'alchemy');
  assert.equal(getRpcProviderLabel(ALCHEMY_BASE), 'alchemy');
  assert.equal(getRpcProviderLabel(INFURA), 'infura');
  assert.equal(
    getRpcProviderLabel('https://base-mainnet.core.chainstack.com/secret-path'),
    'chainstack',
  );
  assert.equal(getRpcProviderLabel('https://mainnet.base.org'), 'mainnet.base.org');
  assert.equal(getRpcProviderLabel('not a URL'), 'unknown');
});

test('Alchemy pacing uses method weights while preserving the fixed legacy override', () => {
  assert.deepEqual(getAlchemyComputeUnits('eth_blockNumber'), { computeUnits: 10, known: true });
  assert.deepEqual(getAlchemyComputeUnits('unknown_method'), { computeUnits: 120, known: false });

  assert.equal(getRpcPacingGapMs(ALCHEMY_ETH, 'eth_blockNumber', {}), 20);
  assert.equal(getRpcPacingGapMs(ALCHEMY_ETH, 'eth_getBlockByNumber', {}), 34);
  assert.equal(getRpcPacingGapMs(ALCHEMY_ETH, 'eth_call', {}), 44);
  assert.equal(getRpcPacingGapMs(ALCHEMY_ETH, 'eth_getLogs', {}), 100);
  assert.equal(getRpcPacingGapMs(ALCHEMY_ETH, 'alchemy_getAssetTransfers', {}), 200);
  assert.equal(getRpcPacingGapMs(INFURA, 'eth_getLogs', {}), 100);

  assert.equal(getRpcPacingGapMs(ALCHEMY_ETH, 'alchemy_getAssetTransfers', { RPC_MIN_INTERVAL_MS: '0' }), 0);
  assert.equal(getRpcPacingGapMs(INFURA, 'eth_getLogs', { RPC_MIN_INTERVAL_MS: '0' }), 0);
  assert.equal(getRpcPacingGapMs(ALCHEMY_ETH, 'eth_blockNumber', { RPC_MIN_INTERVAL_MS: '75' }), 75);
  assert.equal(
    getRpcPacingGapMs(ALCHEMY_ETH, 'eth_getLogs', { RPC_ALCHEMY_TARGET_CUPS: 'invalid' }),
    100,
  );
});

test('concurrent reservations serialize one shared Alchemy bucket but not Infura', async () => {
  const sleeps: Array<{ ms: number; resolve: () => void }> = [];
  const tracker = createRpcRunUsageTracker({
    env: {},
    now: () => 0,
    sleep: (ms: number) => new Promise<void>((resolve) => sleeps.push({ ms, resolve })),
  });

  await tracker.beforeAttempt(ALCHEMY_ETH, 'eth_blockNumber');
  const first = tracker.beforeAttempt(ALCHEMY_BASE, 'eth_getLogs');
  const second = tracker.beforeAttempt(ALCHEMY_ETH, 'eth_blockNumber');
  await tracker.beforeAttempt(INFURA, 'eth_getLogs');

  assert.deepEqual(sleeps.map((entry) => entry.ms), [20, 120]);
  for (const pending of sleeps) pending.resolve();
  await Promise.all([first, second]);

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.requestCount, 4);
  assert.equal(snapshot.pacingWaitMs, 140);
  assert.equal(snapshot.estimatedAlchemyComputeUnitsUpperBound, 80);
  assert.equal(snapshot.providers.alchemy.requestCount, 3);
  assert.equal(snapshot.providers.infura.requestCount, 1);
});

test('unknown Alchemy methods use a conservative CU estimate and sanitized telemetry keys', () => {
  const tracker = createRpcRunUsageTracker({ env: { RPC_MIN_INTERVAL_MS: '0' } });
  tracker.recordAttempt(ALCHEMY_ETH, 'alchemy_futureMethod');
  const snapshot = tracker.snapshot();

  assert.equal(snapshot.requestCount, 1);
  assert.equal(snapshot.estimatedAlchemyComputeUnitsUpperBound, 120);
  assert.deepEqual(snapshot.unknownAlchemyMethods, ['alchemy_futureMethod']);
  assert.deepEqual(Object.keys(snapshot.providers), ['alchemy']);
  assert.ok(!JSON.stringify(snapshot).includes('secret-key'));
});

test('telemetry writer replaces components, resets stale runs, and recovers from corruption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ixs-rpc-usage-'));
  const file = path.join(dir, 'rpc_usage.json');
  const nowIso = () => '2026-08-02T00:00:00.000Z';

  try {
    assert.equal(
      writeRpcUsageComponent(file, 'poolVolume', 'run-1', {
        requestCount: 2,
        pacingWaitMs: 100,
        estimatedAlchemyComputeUnitsUpperBound: 120,
      }, { reset: true, nowIso }),
      true,
    );
    assert.equal(
      writeRpcUsageComponent(file, 'holderRankings', 'run-1', {
        requestCount: 3,
        pacingWaitMs: 200,
        estimatedAlchemyComputeUnitsUpperBound: 240,
      }, { nowIso }),
      true,
    );

    let payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(payload.totals, {
      requestCount: 5,
      pacingWaitMs: 300,
      estimatedAlchemyComputeUnitsUpperBound: 360,
    });

    writeRpcUsageComponent(file, 'holderRankings', 'run-1', {
      requestCount: 1,
      pacingWaitMs: 20,
      estimatedAlchemyComputeUnitsUpperBound: 10,
    }, { nowIso });
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(payload.totals.requestCount, 3, 'repeated flushes replace rather than double-count');

    writeRpcUsageComponent(file, 'holderRankings', 'run-2', {
      requestCount: 4,
      pacingWaitMs: 0,
      estimatedAlchemyComputeUnitsUpperBound: 40,
    }, { nowIso });
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(payload.runId, 'run-2');
    assert.deepEqual(Object.keys(payload.components), ['holderRankings']);

    fs.writeFileSync(file, '{corrupt');
    assert.equal(
      writeRpcUsageComponent(file, 'poolVolume', 'run-3', {
        requestCount: 1,
        pacingWaitMs: 0,
        estimatedAlchemyComputeUnitsUpperBound: 0,
      }, { nowIso }),
      true,
    );
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(payload.runId, 'run-3');
    assert.deepEqual(Object.keys(payload.components), ['poolVolume']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('telemetry write failures are best-effort and never throw', () => {
  const warnings: string[] = [];
  assert.equal(
    writeRpcUsageComponent('\0invalid', 'poolVolume', 'run-1', { requestCount: 1 }, {
      warn: (message: string) => warnings.push(message),
    }),
    false,
  );
  assert.equal(warnings.length, 1);
});
