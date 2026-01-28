import { NextResponse } from 'next/server';
import axios from 'axios';

const API_BASE_URL = 'https://api.etherscan.io/v2/api';
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const API_TIMEOUT = 10000; // 10 seconds

// Ethereum Configuration
const ETH_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_ETH_TOKEN_ADDRESS || '';
const ETH_BURN_ADDRESSES_STRING = process.env.NEXT_PUBLIC_ETH_BURN_ADDRESSES || '';
const ETH_BURN_ADDRESSES = ETH_BURN_ADDRESSES_STRING.split(',')
  .map((addr: string) => addr.trim())
  .filter((addr: string) => addr.length > 0);

// Polygon Configuration
const POLYGON_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS || '';
const POLYGON_BURN_ADDRESSES_STRING = process.env.NEXT_PUBLIC_POLYGON_BURN_ADDRESSES || '';
const POLYGON_BURN_ADDRESSES = POLYGON_BURN_ADDRESSES_STRING.split(',')
  .map((addr: string) => addr.trim())
  .filter((addr: string) => addr.length > 0);

console.log('[burnStats API] Configuration loaded');

function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

async function fetchBalancesForNetwork(
  tokenAddress: string,
  burnAddresses: string[],
  chainId: string,
  network: 'ethereum' | 'polygon'
): Promise<Record<string, string>> {
  const balances: Record<string, string> = {};

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
      balances[trimmedAddress] = '0';
      continue;
    }

    try {
      console.log(`[burnStats API] Fetching ${network} balance for ${trimmedAddress} with chainid ${chainId}`);

      const response = await axios.get(API_BASE_URL, {
        params: {
          chainid: chainId,
          module: 'account',
          action: 'tokenbalance',
          contractaddress: tokenAddress,
          address: trimmedAddress,
          tag: 'latest',
          apikey: ETHERSCAN_API_KEY,
        },
        timeout: API_TIMEOUT,
      });

      console.log(`[burnStats API] ${network} response for ${trimmedAddress}:`, {
        status: response.data.status,
        message: response.data.message,
        resultLength: response.data.result ? response.data.result.length : 0,
      });

      if (response.data.status !== '1' || response.data.message !== 'OK') {
        console.warn(
          `[burnStats API] API returned non-OK status for ${trimmedAddress} on ${network}: ${response.data.message}`
        );
        balances[trimmedAddress] = '0';
        continue;
      }

      let balance = response.data.result || '0';

      if (typeof balance !== 'string') {
        balance = String(balance);
      }

      balance = balance.trim();

      if (!balance || !/^\d+$/.test(balance)) {
        console.warn(`[burnStats API] Invalid balance format for ${trimmedAddress}`);
        balance = '0';
      }

      balances[trimmedAddress] = balance;
      console.log(`[burnStats API] ${network} balance for ${trimmedAddress}: ${balance}`);
    } catch (error) {
      console.error(`[burnStats API] Error fetching ${network} balance for ${trimmedAddress}:`, error);
      // Don't expose API error details to client
      balances[trimmedAddress] = '0';
    }
  }

  return balances;
}

export async function GET() {
  try {
    // Validate API key exists (on server side only)
    if (!ETHERSCAN_API_KEY) {
      console.error('[burnStats API] ETHERSCAN_API_KEY not configured');
      return NextResponse.json(
        { error: 'Service misconfiguration' },
        { status: 500 }
      );
    }

    console.log('[burnStats API] Processing request...');

    let ethereumBalances: Record<string, string> = {};
    let polygonBalances: Record<string, string> = {};

    // Fetch Ethereum balances
    if (ETH_TOKEN_ADDRESS && ETH_BURN_ADDRESSES.length > 0) {
      ethereumBalances = await fetchBalancesForNetwork(
        ETH_TOKEN_ADDRESS,
        ETH_BURN_ADDRESSES,
        '1',
        'ethereum'
      );
    }

    // Fetch Polygon balances
    if (POLYGON_TOKEN_ADDRESS && POLYGON_BURN_ADDRESSES.length > 0) {
      polygonBalances = await fetchBalancesForNetwork(
        POLYGON_TOKEN_ADDRESS,
        POLYGON_BURN_ADDRESSES,
        '137',
        'polygon'
      );
    }

    console.log('[burnStats API] Returning results');

    return NextResponse.json(
      {
        ethereum: {
          balances: ethereumBalances,
        },
        polygon: {
          balances: polygonBalances,
        },
      },
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
