import { test } from 'node:test';
import assert from 'node:assert/strict';
import transport from '../scripts/rpc_transport.js';

const { readRpcResponse, withRpcResponse, sanitizeRpcMessage, createProviderCooldowns } = transport;

test('RPC deadline aborts a stalled fetch and a stalled response body', async () => {
  for (const stallBody of [false, true]) {
    let signal: AbortSignal | undefined;
    await assert.rejects(readRpcResponse('https://rpc.invalid/key', {}, {
      timeoutMs: 10,
      fetchImpl: async (_url: string, options: RequestInit) => {
        signal = options.signal as AbortSignal;
        if (!stallBody) return new Promise(() => {});
        return { ok: true, status: 200, text: () => new Promise(() => {}) };
      },
    }), (error: Error & { code?: string }) => error.code === 'RPC_TIMEOUT');
    assert.equal(signal?.aborted, true);
  }
});

test('RPC timeout also disposes of a response that arrives after the caller has returned', async () => {
  let resolveFetch!: (response: Response) => void;
  let cancelled = false;
  const pending = readRpcResponse('https://rpc.invalid/key', {}, {
    timeoutMs: 10,
    fetchImpl: () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
  });
  await assert.rejects(pending, { code: 'RPC_TIMEOUT' });
  resolveFetch(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('late unread response')); },
    cancel() { cancelled = true; },
  })));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true, 'late fetch completion must not leave its body stream open');
});

test('completed response is reusable after transport cleanup and invalid JSON fails safely', async () => {
  const response = await readRpcResponse('https://rpc.invalid/key', {}, {
    timeoutMs: 100,
    fetchImpl: async () => new Response('{"jsonrpc":"2.0","id":1,"result":[]}', {
      headers: { 'Retry-After': '3' },
    }),
  });
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 1, result: [] });
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 1, result: [] });
  assert.equal(response.headers.get('retry-after'), '3');
  const malformed = await readRpcResponse('https://rpc.invalid/key', {}, {
    fetchImpl: async () => new Response('secret invalid body'),
  });
  await assert.rejects(malformed.json(), { message: 'Invalid JSON RPC response', code: 'RPC_INVALID_RESPONSE' });
});

test('RPC transport preserves external cancellation and never starts pre-cancelled work', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(readRpcResponse('https://rpc.invalid/key', { signal: controller.signal }, {
    fetchImpl: async () => { calls++; return new Response('{}'); },
  }), { code: 'RPC_ABORTED' });
  assert.equal(calls, 0);
});

test('RPC transport removes keyed URLs from errors without losing classification', async () => {
  const error = Object.assign(new Error('fetch failed at https://user:pass@rpc.invalid/private?key=credential'), {
    code: 'ECONNRESET', status: 503,
  });
  await assert.rejects(withRpcResponse('https://rpc.invalid/key', {}, () => {}, {
    fetchImpl: async () => { throw error; },
  }), (caught: Error & { code?: string; status?: number }) => {
    assert.equal(caught.code, 'ECONNRESET');
    assert.equal(caught.status, 503);
    assert.equal(caught.message, 'fetch failed at [RPC rpc.invalid]');
    assert.ok(!JSON.stringify(caught).includes('credential'));
    return true;
  });
  assert.equal(sanitizeRpcMessage('bad abc+key abc%2Bkey https://host.invalid/path?k=abc+key', {
    ALCHEMY_API_KEY: 'abc+key',
  }), 'bad [redacted] [redacted] [RPC host.invalid]');
  assert.equal(sanitizeRpcMessage('failed https://secret-node.rpc.invalid', {
    BSC_RPC_URL: 'https://secret-node.rpc.invalid',
  }), 'failed [redacted]', 'configured hostname credentials must not survive URL formatting');
});

test('cooldowns skip failing providers on healthy requests but retain every recovery path', () => {
  let now = 0;
  const cooldowns = createProviderCooldowns({ now: () => now, cooldownMs: 100 });
  const urls = ['a', 'b'];
  cooldowns.failed('a', 'eth_getLogs', Object.assign(new Error('bad gateway'), { status: 502 }));
  assert.deepEqual(cooldowns.order(urls, 'eth_getLogs'), ['b', 'a']);
  assert.deepEqual(cooldowns.order(urls, 'eth_call'), ['a', 'b'], 'health is method-specific');
  now = 10;
  cooldowns.failed('b', 'eth_getLogs', Object.assign(new Error('timeout'), { code: 'RPC_TIMEOUT' }));
  assert.deepEqual(cooldowns.order(urls, 'eth_getLogs'), ['a', 'b'], 'all cooling providers remain recoverable');
  cooldowns.succeeded('b', 'eth_getLogs');
  assert.deepEqual(cooldowns.order(urls, 'eth_getLogs'), ['b', 'a']);
  now = 101;
  assert.deepEqual(cooldowns.order(urls, 'eth_getLogs'), urls, 'expired cooldown restores normal priority');
  cooldowns.failed('a', 'eth_getLogs', Object.assign(new Error('invalid range'), { code: 'RPC_INVALID_RESPONSE' }));
  assert.deepEqual(cooldowns.order(urls, 'eth_getLogs'), urls, 'a bad query must not penalize transport health');
});

test('cooldown expiry during ordering never drops the sole recovery provider', () => {
  const times = [0, 0, 1];
  const cooldowns = createProviderCooldowns({ now: () => times.shift() ?? 1, cooldownMs: 1 });
  const urls = ['recovering-provider'];
  cooldowns.failed(urls[0], 'eth_getLogs', Object.assign(new Error('timeout'), { code: 'RPC_TIMEOUT' }));

  assert.deepEqual(cooldowns.order(urls, 'eth_getLogs'), urls);
  assert.deepEqual(cooldowns.order(urls, 'eth_getLogs'), urls, 'the expired provider remains available on the next request');
});
