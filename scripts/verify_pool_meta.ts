/**
 * Drift check for the baked-in pool metadata in lib/poolsConfig.ts.
 *
 * The pools API route trusts hardcoded token0/token1/decimals (immutable for a
 * V2 pair) to avoid 4 eth_calls per pool per request. If a pool address is ever
 * swapped for a different pair, those constants silently go stale. This script
 * uses two dependent Multicall3 phases per chain, then compares the actual
 * token addresses and their actual decimals with the baked configuration.
 * Failed or malformed subcalls retain individual eth_call fallback.
 *
 * Run: npm run verify:pool-meta   (loads .env.local locally; uses env in CI)
 */
import fs from 'fs';
import path from 'path';
import multicall3Codec from '../lib/multicall3Codec.js';
import {
  verifyPoolMetadata,
  type PoolMetaVerificationRpc,
} from '../lib/poolMetaVerifier';
import { POOLS } from '../lib/poolsConfig';
import type { ChainNetwork } from '../types';

// Minimal .env.local loader (parity with the updater scripts).
const envPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

const ALCHEMY_API_KEY = String(process.env.ALCHEMY_API_KEY || '').trim();
const DEFAULT_MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ADDRESS = String(
  process.env.MULTICALL3_ADDRESS || DEFAULT_MULTICALL3_ADDRESS,
).trim();
const networkToAlchemy: Record<ChainNetwork, string> = {
  ethereum: 'eth-mainnet',
  polygon: 'polygon-mainnet',
  base: 'base-mainnet',
};

async function ethCall(url: string, to: string, data: string): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const json = (await response.json()) as { result?: string; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  if (!json.result) throw new Error('missing rpc result');
  return json.result;
}

function rpcUrl(network: ChainNetwork): string {
  return `https://${networkToAlchemy[network]}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
}

function createRpc(): PoolMetaVerificationRpc {
  return {
    async multicall(network, calls) {
      const encoded = multicall3Codec.encodeAggregate3Call(calls);
      const raw = await ethCall(rpcUrl(network), MULTICALL3_ADDRESS, encoded);
      return multicall3Codec.decodeAggregate3Result(raw);
    },
    async ethCall(network, target, callData) {
      return ethCall(rpcUrl(network), target, callData);
    },
  };
}

async function main() {
  if (!ALCHEMY_API_KEY) {
    console.error('[verify-pool-meta] ALCHEMY_API_KEY is not set');
    process.exit(2);
  }
  if (!/^0x[0-9a-f]{40}$/i.test(MULTICALL3_ADDRESS)) {
    console.error('[verify-pool-meta] MULTICALL3_ADDRESS is invalid');
    process.exit(2);
  }

  const results = await verifyPoolMetadata(POOLS, createRpc());
  const drift = results.filter((result) => result.status === 'drift');

  for (const result of results) {
    const pool = result.pool;
    if (result.status === 'skipped') {
      console.log(`[verify-pool-meta] ${pool.name}: no baked meta (live discovery), skipping`);
    } else if (result.status === 'unverified') {
      // A transient RPC failure shouldn't fail the check; only real drift should.
      console.warn(`[verify-pool-meta] could not verify ${pool.name}: ${result.error}`);
    } else if (result.status === 'drift') {
      console.error(`[verify-pool-meta] DRIFT ${pool.name}: ${result.mismatches.join('; ')}`);
    } else {
      console.log(`[verify-pool-meta] ok ${pool.name}`);
    }
  }

  if (drift.length) {
    console.error(`[verify-pool-meta] ${drift.length} pool(s) drifted - update lib/poolsConfig.ts`);
    process.exit(1);
  }
  console.log('[verify-pool-meta] all baked pool metadata matches chain');
}

main().catch((error) => {
  console.error('[verify-pool-meta] failed:', error);
  process.exit(1);
});
