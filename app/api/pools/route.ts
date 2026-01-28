import { NextResponse } from 'next/server';
import axios from 'axios';

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const API_TIMEOUT = 15000;

// Network to Alchemy network mapping
const networkToAlchemy: Record<string, string> = {
  ethereum: 'eth-mainnet',
  polygon: 'polygon-mainnet',
  base: 'base-mainnet'
};

// Pool configurations
const POOLS = [
  {
    type: 'RWA',
    name: 'IXAPE',
    address: '0xfe3d92cf0292a4e44402d1e6a10ae8b575fa61dc',
    network: 'ethereum' as const,
    tokenAddress: '0x73d7c860998ca3c01ce8c808f5577d94d545d1b4' // IXS token address
  }
];

console.log('[pools API] Configuration loaded');

async function fetchPoolValue(pool: typeof POOLS[0]): Promise<string> {
  try {
    console.log(`[pools API] Fetching ${pool.name} pool value`);

    const alchemyNetwork = networkToAlchemy[pool.network];
    const alchemyUrl = `https://${alchemyNetwork}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        {
          to: pool.tokenAddress,
          data: `0x70a08231000000000000000000000000${pool.address.slice(2)}`
        },
        "latest"
      ]
    };

    const response = await axios.post(alchemyUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: API_TIMEOUT,
    });

    if (!response.data.result) {
      console.warn(`[pools API] No result for ${pool.name}`);
      return '0';
    }

    const balance = BigInt(response.data.result).toString();
    console.log(`[pools API] ${pool.name} value: ${balance}`);
    return balance;
  } catch (error) {
    console.error(`[pools API] Error fetching ${pool.name} pool value:`, error);
    return '0';
  }
}

export async function GET() {
  try {
    // Validate API key exists
    if (!ALCHEMY_API_KEY) {
      console.error('[pools API] ALCHEMY_API_KEY not configured');
      return NextResponse.json(
        { error: 'Service misconfiguration' },
        { status: 500 }
      );
    }

    console.log('[pools API] Processing request...');

    const poolsData = await Promise.all(
      POOLS.map(async (pool) => {
        const value = await fetchPoolValue(pool);
        return {
          ...pool,
          value
        };
      })
    );

    console.log('[pools API] Returning pools data');

    return NextResponse.json(
      { pools: poolsData },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200',
        },
      }
    );
  } catch (error) {
    console.error('[pools API] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}