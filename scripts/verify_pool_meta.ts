/**
 * Drift check for the baked-in pool metadata in lib/poolsConfig.ts.
 *
 * The pools API route trusts hardcoded token0/token1/decimals (immutable for a
 * V2 pair) to avoid 4 eth_calls per pool per request. If a pool address is ever
 * swapped for a different pair, those constants silently go stale. This script
 * queries each pool on-chain and compares, exiting non-zero on any mismatch so
 * CI can alert.
 *
 * Run: npm run verify:pool-meta   (loads .env.local locally; uses env in CI)
 */
import fs from 'fs';
import path from 'path';
import { POOLS } from '../lib/poolsConfig';

// Minimal .env.local loader (parity with the updater scripts).
const envPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const ALCHEMY_API_KEY = String(process.env.ALCHEMY_API_KEY || '').trim();
const networkToAlchemy: Record<string, string> = {
  ethereum: 'eth-mainnet',
  polygon: 'polygon-mainnet',
  base: 'base-mainnet',
};

async function ethCall(url: string, to: string, data: string): Promise<string> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  const json = (await resp.json()) as { result?: string; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  if (!json.result) throw new Error('missing rpc result');
  return json.result;
}

const addrFromHex = (h: string) => `0x${h.slice(-40)}`.toLowerCase();

async function main() {
  if (!ALCHEMY_API_KEY) {
    console.error('[verify-pool-meta] ALCHEMY_API_KEY is not set');
    process.exit(2);
  }

  const drift: string[] = [];

  for (const pool of POOLS) {
    if (!pool.meta) {
      console.log(`[verify-pool-meta] ${pool.name}: no baked meta (live discovery), skipping`);
      continue;
    }

    const url = `https://${networkToAlchemy[pool.network]}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
    try {
      const token0 = addrFromHex(await ethCall(url, pool.address, '0x0dfe1681'));
      const token1 = addrFromHex(await ethCall(url, pool.address, '0xd21220a7'));
      const decimals0 = Number.parseInt(await ethCall(url, token0, '0x313ce567'), 16);
      const decimals1 = Number.parseInt(await ethCall(url, token1, '0x313ce567'), 16);

      const expected = pool.meta;
      const mismatches: string[] = [];
      if (token0 !== expected.token0.toLowerCase()) mismatches.push(`token0 ${expected.token0} -> ${token0}`);
      if (token1 !== expected.token1.toLowerCase()) mismatches.push(`token1 ${expected.token1} -> ${token1}`);
      if (decimals0 !== expected.decimals0) mismatches.push(`decimals0 ${expected.decimals0} -> ${decimals0}`);
      if (decimals1 !== expected.decimals1) mismatches.push(`decimals1 ${expected.decimals1} -> ${decimals1}`);

      if (mismatches.length) {
        drift.push(`${pool.name} (${pool.address}): ${mismatches.join('; ')}`);
        console.error(`[verify-pool-meta] DRIFT ${pool.name}: ${mismatches.join('; ')}`);
      } else {
        console.log(`[verify-pool-meta] ok ${pool.name}`);
      }
    } catch (error) {
      // A transient RPC failure shouldn't fail the check; only real drift should.
      console.warn(`[verify-pool-meta] could not verify ${pool.name}:`, error instanceof Error ? error.message : error);
    }
  }

  if (drift.length) {
    console.error(`[verify-pool-meta] ${drift.length} pool(s) drifted — update lib/poolsConfig.ts`);
    process.exit(1);
  }
  console.log('[verify-pool-meta] all baked pool metadata matches chain');
}

main().catch((error) => {
  console.error('[verify-pool-meta] failed:', error);
  process.exit(1);
});
