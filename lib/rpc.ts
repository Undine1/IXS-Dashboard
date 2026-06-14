import type { ChainNetwork } from '@/types';

// Shared JSON-RPC plumbing for the pools and burnStats API routes.
// Provider priority per chain: Alchemy -> Infura -> (Base only) Chainstack.
//
// Retry budgets here are sized for serverless: Vercel kills the function long
// before a CI-style budget would finish, so prefer failing over to the next
// provider quickly and bound the total time spent per call. The CI updater
// scripts keep their own, larger budgets.

const ALCHEMY_API_KEY = String(process.env.ALCHEMY_API_KEY || '').trim();
const BACKUP_INFURA_API_KEY = String(process.env.BACKUP_INFURA_API_KEY || '').trim();
const BACKUP_CHAINSTACK_BASE_RPC_URL = String(process.env.BACKUP_CHAINSTACK_BASE_RPC_URL || '').trim();

const API_TIMEOUT_MS = 10000; // per request
const MAX_RETRIES_PER_PROVIDER = 2; // attempts per provider = retries + 1
const TOTAL_BUDGET_MS = 12000; // soft deadline across all providers/retries
const INITIAL_RETRY_DELAY_MS = 400;

const networkToAlchemy: Record<ChainNetwork, string> = {
  ethereum: 'eth-mainnet',
  polygon: 'polygon-mainnet',
  base: 'base-mainnet',
};
const networkToInfura: Record<ChainNetwork, string> = {
  ethereum: 'mainnet',
  polygon: 'polygon-mainnet',
  base: 'base-mainnet',
};

export function hasAnyRpcConfigured(): boolean {
  return Boolean(ALCHEMY_API_KEY || BACKUP_INFURA_API_KEY || BACKUP_CHAINSTACK_BASE_RPC_URL);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientErrorMessage(message: string): boolean {
  return /timeout|ECONNRESET|ENOTFOUND|rate limit|429|throttle/i.test(message);
}

export function getRpcUrls(network: ChainNetwork): string[] {
  const alchemyNetwork = networkToAlchemy[network];
  const infuraNetwork = networkToInfura[network];

  const urls: string[] = [];
  const addUrl = (url: string | null) => {
    if (!url) return;
    if (!urls.includes(url)) urls.push(url);
  };

  addUrl(ALCHEMY_API_KEY && alchemyNetwork ? `https://${alchemyNetwork}.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : null);
  addUrl(BACKUP_INFURA_API_KEY && infuraNetwork ? `https://${infuraNetwork}.infura.io/v3/${BACKUP_INFURA_API_KEY}` : null);
  addUrl(network === 'base' ? BACKUP_CHAINSTACK_BASE_RPC_URL || null : null);
  return urls;
}

// Posts a JSON-RPC payload, walking the provider list and retrying transient
// failures (timeouts, 429s) with exponential backoff. Non-transient errors
// (4xx/5xx, reverts) fail over to the next provider immediately. Returns the
// raw `result` string.
export async function rpcCall(
  rpcUrls: string[],
  payload: Record<string, unknown>,
  maxRetries = MAX_RETRIES_PER_PROVIDER,
): Promise<string> {
  if (!rpcUrls.length) {
    throw new Error('rpcCall: no RPC API key configured');
  }

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastError: unknown = null;

  for (const rpcUrl of rpcUrls) {
    let attempt = 0;
    let delay = INITIAL_RETRY_DELAY_MS;

    while (attempt <= maxRetries) {
      try {
        // Each provider gets at least one attempt even when the budget is
        // nearly spent, but with a clamped timeout so the call stays bounded.
        const timeoutMs = Math.max(1000, Math.min(API_TIMEOUT_MS, deadline - Date.now()));
        const resp = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }

        const data = (await resp.json()) as {
          result?: string;
          error?: { message?: string };
        };

        if (data.error) {
          throw new Error(data.error.message || JSON.stringify(data.error));
        }

        if (!data.result) {
          throw new Error('missing rpc result');
        }

        return data.result;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        const canRetry =
          attempt < maxRetries && isTransientErrorMessage(msg) && Date.now() + delay < deadline;
        if (canRetry) {
          await sleep(delay);
          attempt += 1;
          delay *= 2;
          continue;
        }
        break;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('rpcCall: exceeded retries');
}
