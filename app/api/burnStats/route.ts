import { NextResponse } from 'next/server';
import axios from 'axios';

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const API_TIMEOUT = 15000; // 15 seconds

interface BurnStatsApiResponse {
  ethereum: { balances: Record<string, string | null> };
  polygon: { balances: Record<string, string | null> };
  base: { balances: Record<string, string | null> };
}

// Cache configuration
let cachedData: BurnStatsApiResponse | null = null;
let lastFetchTime: number = 0;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds

// Network to Alchemy network mapping
const networkToAlchemy: Record<string, string> = {
  ethereum: 'eth-mainnet',
  polygon: 'polygon-mainnet',
  base: 'base-mainnet'
};

// Ethereum Configuration
const ETH_TOKEN_ADDRESS = (process.env.NEXT_PUBLIC_ETH_TOKEN_ADDRESS || '').trim();
const ETH_BURN_ADDRESSES_STRING = process.env.NEXT_PUBLIC_ETH_BURN_ADDRESSES || '';
const ETH_BURN_ADDRESSES = ETH_BURN_ADDRESSES_STRING.split(',')
  .map((addr: string) => addr.trim())
  .filter((addr: string) => addr.length > 0);

// Polygon Configuration
const POLYGON_TOKEN_ADDRESS = (process.env.NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS || '').trim();
const POLYGON_BURN_ADDRESSES_STRING = process.env.NEXT_PUBLIC_POLYGON_BURN_ADDRESSES || '';
const POLYGON_BURN_ADDRESSES = POLYGON_BURN_ADDRESSES_STRING.split(',')
  .map((addr: string) => addr.trim())
  .filter((addr: string) => addr.length > 0);

// Base Configuration
const BASE_TOKEN_ADDRESS = (process.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS || '').trim();
const BASE_BURN_ADDRESSES_STRING = process.env.NEXT_PUBLIC_BASE_BURN_ADDRESSES || '';
const BASE_BURN_ADDRESSES = BASE_BURN_ADDRESSES_STRING.split(',')
  .map((addr: string) => addr.trim())
  .filter((addr: string) => addr.length > 0);

console.log('[burnStats API] Configuration loaded');

function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBalancesForNetwork(
  tokenAddress: string,
  burnAddresses: string[],
  network: 'ethereum' | 'polygon' | 'base'
): Promise<Record<string, string | null>> {
  const balances: Record<string, string | null> = {};

  // Validate inputs
  if (!isValidAddress(tokenAddress)) {
    console.error(`[burnStats API] Invalid token address for ${network}: ${tokenAddress}`);
    return balances;
  }

  for (const address of burnAddresses) {
    const trimmedAddress = address.trim();

    // Validate address format before making API call
    if (!isValidAddress(trimmedAddress)) {
      console.error(`[burnStats API] Invalid address format for ${network}: ${trimmedAddress}`);
      balances[trimmedAddress] = null;
      continue;
    }

    try {
      console.log(`[burnStats API] Fetching ${network} balance for ${trimmedAddress}`);

      const alchemyNetwork = networkToAlchemy[network];
      const alchemyUrl = `https://${alchemyNetwork}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

      const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [
          {
            to: tokenAddress,
            data: `0x70a08231000000000000000000000000${trimmedAddress.slice(2)}`
          },
          "latest"
        ]
      };

      const response = await axios.post(alchemyUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: API_TIMEOUT,
      });

      console.log(`[burnStats API] ${network} response for ${trimmedAddress}:`, response.data);

      if (!response.data.result) {
        console.warn(`[burnStats API] No result for ${trimmedAddress} on ${network}`);
        balances[trimmedAddress] = null;
        continue;
      }

      const balance = BigInt(response.data.result).toString();

      if (!balance || !/^\d+$/.test(balance)) {
        console.warn(`[burnStats API] Invalid balance format for ${trimmedAddress}`);
        balances[trimmedAddress] = null;
        continue;
      }

      balances[trimmedAddress] = balance;
      console.log(`[burnStats API] ${network} balance for ${trimmedAddress}: ${balance}`);
    } catch (error) {
      console.error(`[burnStats API] Error fetching ${network} balance for ${trimmedAddress}:`, error);
      // Don't expose API error details to client
      balances[trimmedAddress] = null;
    }
    await sleep(400); // Add a 400ms delay between requests
  }

  return balances;
}

export async function GET() {
  try {
    // Validate API key exists (on server side only)
    if (!ALCHEMY_API_KEY) {
      console.error('[burnStats API] ALCHEMY_API_KEY not configured');
      return NextResponse.json(
        { error: 'Service misconfiguration' },
        { status: 500 }
      );
    }

    const now = Date.now();
    if (cachedData && (now - lastFetchTime) < CACHE_DURATION) {
      console.log('[burnStats API] Returning cached data');
      return NextResponse.json(cachedData);
    }

    console.log('[burnStats API] Processing request...');
    console.log('[burnStats API] Configuration:', {
      ETH_TOKEN_ADDRESS: ETH_TOKEN_ADDRESS ? 'SET' : 'MISSING',
      ETH_BURN_ADDRESSES_COUNT: ETH_BURN_ADDRESSES.length,
      POLYGON_TOKEN_ADDRESS: POLYGON_TOKEN_ADDRESS ? 'SET' : 'MISSING',
      POLYGON_BURN_ADDRESSES_COUNT: POLYGON_BURN_ADDRESSES.length,
      POLYGON_BURN_ADDRESSES: POLYGON_BURN_ADDRESSES,
      BASE_TOKEN_ADDRESS: BASE_TOKEN_ADDRESS ? 'SET' : 'MISSING',
      BASE_BURN_ADDRESSES_COUNT: BASE_BURN_ADDRESSES.length,
    });

    let ethereumBalances: Record<string, string | null> = {};
    let polygonBalances: Record<string, string | null> = {};
    let baseBalances: Record<string, string | null> = {};

    // Fetch Ethereum balances
    if (ETH_TOKEN_ADDRESS && ETH_BURN_ADDRESSES.length > 0) {
      console.log('[burnStats API] Fetching Ethereum balances...');
      ethereumBalances = await fetchBalancesForNetwork(
        ETH_TOKEN_ADDRESS,
        ETH_BURN_ADDRESSES,
        'ethereum'
      );
      console.log('[burnStats API] Ethereum result:', Object.keys(ethereumBalances).length, 'addresses');
    } else {
      console.warn('[burnStats API] Skipping Ethereum: TOKEN_ADDRESS or addresses not configured');
    }

    // Fetch Polygon balances
    if (POLYGON_TOKEN_ADDRESS && POLYGON_BURN_ADDRESSES.length > 0) {
      console.log('[burnStats API] Fetching Polygon balances...');
      polygonBalances = await fetchBalancesForNetwork(
        POLYGON_TOKEN_ADDRESS,
        POLYGON_BURN_ADDRESSES,
        'polygon'
      );
      console.log('[burnStats API] Polygon result:', Object.keys(polygonBalances).length, 'addresses');
    } else {
      console.warn('[burnStats API] Skipping Polygon: TOKEN_ADDRESS or addresses not configured');
      console.warn('[burnStats API] Polygon config check:', {
        TOKEN_ADDRESS: POLYGON_TOKEN_ADDRESS,
        ADDRESSES: POLYGON_BURN_ADDRESSES,
      });
    }

    // Fetch Base balances
    if (BASE_TOKEN_ADDRESS && BASE_BURN_ADDRESSES.length > 0) {
      console.log('[burnStats API] Fetching Base balances...');
      baseBalances = await fetchBalancesForNetwork(
        BASE_TOKEN_ADDRESS,
        BASE_BURN_ADDRESSES,
        'base'
      );
      console.log('[burnStats API] Base result:', Object.keys(baseBalances).length, 'addresses');
    } else {
      console.warn('[burnStats API] Skipping Base: TOKEN_ADDRESS or addresses not configured');
    }

    console.log('[burnStats API] Returning results');

    const payload: BurnStatsApiResponse = {
      ethereum: { balances: ethereumBalances },
      polygon: { balances: polygonBalances },
      base: { balances: baseBalances }
    };
    cachedData = payload;
    lastFetchTime = now;

    return NextResponse.json(
      payload,
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200',
        },
      }
    );
  } catch (error) {
    console.error('[burnStats API] Unexpected error:', error);
    // Return generic error response without exposing details
    return NextResponse.json(
      { error: 'Failed to fetch burn statistics' },
      { status: 500 }
    );
  }
}
