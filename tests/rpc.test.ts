import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientErrorMessage } from '../lib/rpc';

test('isTransientErrorMessage flags retryable conditions', () => {
  for (const msg of ['request timeout', 'ECONNRESET', 'ENOTFOUND host', 'rate limit exceeded', 'HTTP 429', 'throttled']) {
    assert.equal(isTransientErrorMessage(msg), true, `expected transient: ${msg}`);
  }
});

test('isTransientErrorMessage ignores permanent errors', () => {
  for (const msg of ['execution reverted', 'invalid address', 'missing rpc result', '401 unauthorized']) {
    assert.equal(isTransientErrorMessage(msg), false, `expected permanent: ${msg}`);
  }
});
