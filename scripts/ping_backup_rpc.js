// One attempted keepalive per UTC day, independent of which scheduler woke us.
// This control file is separate from blockchain balances/checkpoints.
// @ts-check
const fs = require('node:fs');
const path = require('node:path');

/** @param {{ url: string, statePath: string, now?: number, fetchImpl?: typeof fetch }} options */
async function pingBackupRpc({ url, statePath, now = Date.now(), fetchImpl = fetch }) {
  if (!url.trim()) return 'not-configured';
  const day = new Date(now).toISOString().slice(0, 10);
  try {
    if (JSON.parse(fs.readFileSync(statePath, 'utf8')).lastKeepaliveAttemptDay === day) return 'already-attempted';
  } catch { /* A missing/invalid control file permits one cheap recovery ping. */ }
  let result = 'request-failed';
  try {
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 'chainstack-keepalive' }),
    });
    // Preserve the old ping's RPC-level health check without logging provider
    // response bodies or credential-bearing URLs. Bound even a broken response.
    result = `http-${response.status}`;
    if (!response.ok) await response.body?.cancel();
    else if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 8192) throw new Error('response-too-large');
          text += decoder.decode(value, { stream: true });
        }
        const payload = JSON.parse(text + decoder.decode());
        result = payload?.error ? 'rpc-error'
          : typeof payload?.result === 'string' && /^0x[0-9a-f]+$/i.test(payload.result) ? 'rpc-ok' : 'invalid-response';
      } catch {
        result = 'invalid-response';
      } finally {
        await reader.cancel();
      }
    } else result = 'invalid-response';
  } catch { /* Keepalive failure must never prevent the actual data refresh. */ }
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temporary = `${statePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ lastKeepaliveAttemptDay: day }, null, 2)}\n`);
    fs.renameSync(temporary, statePath);
  } catch {
    console.warn('::warning::Could not persist keepalive day; a later run may repeat one ping');
  }
  return result;
}

if (require.main === module) {
  pingBackupRpc({
    url: process.env.BACKUP_CHAINSTACK_BASE_RPC_URL || '',
    statePath: path.join(__dirname, '..', 'data', 'scheduler_control.json'),
  }).then((result) => console.log(`Chainstack daily keepalive: ${result}`)).catch(() => {
    console.warn('::warning::Chainstack daily keepalive could not run');
  });
}

module.exports = { pingBackupRpc };
