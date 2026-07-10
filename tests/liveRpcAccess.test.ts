import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_RPC_TOKEN_HEADER,
  isLiveRpcRequestAuthorized,
} from '../lib/liveRpcAccess';

const originalToken = process.env.RPC_LIVE_READ_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.RPC_LIVE_READ_TOKEN;
  else process.env.RPC_LIVE_READ_TOKEN = originalToken;
});

test('live RPC access stays disabled when no server token is configured', () => {
  delete process.env.RPC_LIVE_READ_TOKEN;
  const request = new Request('https://example.test/api/pools?fresh=1', {
    headers: { [LIVE_RPC_TOKEN_HEADER]: 'supplied-token' },
  });

  assert.equal(isLiveRpcRequestAuthorized(request), false);
});

test('live RPC access requires an exact header token match', () => {
  process.env.RPC_LIVE_READ_TOKEN = 'server-secret';

  const missing = new Request('https://example.test/api/pools?fresh=1');
  const wrong = new Request('https://example.test/api/pools?fresh=1', {
    headers: { [LIVE_RPC_TOKEN_HEADER]: 'wrong-secret' },
  });
  const correct = new Request('https://example.test/api/pools?fresh=1', {
    headers: { [LIVE_RPC_TOKEN_HEADER]: 'server-secret' },
  });

  assert.equal(isLiveRpcRequestAuthorized(missing), false);
  assert.equal(isLiveRpcRequestAuthorized(wrong), false);
  assert.equal(isLiveRpcRequestAuthorized(correct), true);
});
