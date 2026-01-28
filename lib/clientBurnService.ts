import { TokenBurnStats, BurnAddress } from '@/types';

const BURN_ADDRESS_LABELS: Record<string, string> = {
  '0x000000000000000000000000000000000000dead': 'Black Hole (Dead Address)',
  '0x73d7c860998ca3c01ce8c808f5577d94d545d1b4': 'IXS Contract',
  '0xec36cffd536fac67513871e114df58470696734b': 'Burn Address 3',
  '0x1ba17c639bdaecd8dc4aac37df062d17ee43a1b8': 'Polygon IXS Contract',
};

function formatAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export async function fetchTokenBurnStatsFromAPI(): Promise<TokenBurnStats> {
  try {
    const response = await fetch('/api/burnStats', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error('[Client] API error:', response.statusText);
      return {
        totalBurned: '0',
        burnAddresses: [],
        lastUpdated: Date.now(),
      };
    }

    const data = await response.json();
    console.log('[Client] Received raw API response:', data);

    // Parse the API response and convert to TokenBurnStats format
    const allBurnAddresses: BurnAddress[] = [];
    let totalBurned = BigInt(0);

    // Process Ethereum balances
    if (data.ethereum && typeof data.ethereum.balances === 'object') {
      console.log('[Client] Processing Ethereum balances:', data.ethereum.balances);
      for (const [address, balance] of Object.entries(data.ethereum.balances)) {
        try {
          const balanceStr = String(balance);
          const balanceBigInt = BigInt(balanceStr);
          totalBurned += balanceBigInt;

          allBurnAddresses.push({
            address,
            balance: balanceStr,
            label: BURN_ADDRESS_LABELS[address.toLowerCase()] || formatAddress(address),
            network: 'ethereum',
          });
        } catch (err) {
          console.error('[Client] Error processing Ethereum address:', address, err);
        }
      }
    }

    // Process Polygon balances
    if (data.polygon && typeof data.polygon.balances === 'object') {
      console.log('[Client] Processing Polygon balances:', data.polygon.balances);
      for (const [address, balance] of Object.entries(data.polygon.balances)) {
        try {
          const balanceStr = String(balance);
          const balanceBigInt = BigInt(balanceStr);
          totalBurned += balanceBigInt;

          allBurnAddresses.push({
            address,
            balance: balanceStr,
            label: BURN_ADDRESS_LABELS[address.toLowerCase()] || formatAddress(address),
            network: 'polygon',
          });
        } catch (err) {
          console.error('[Client] Error processing Polygon address:', address, err);
        }
      }
    }

    // Process Base balances
    if (data.base && typeof data.base.balances === 'object') {
      console.log('[Client] Processing Base balances:', data.base.balances);
      for (const [address, balance] of Object.entries(data.base.balances)) {
        try {
          const balanceStr = String(balance);
          const balanceBigInt = BigInt(balanceStr);
          totalBurned += balanceBigInt;

          allBurnAddresses.push({
            address,
            balance: balanceStr,
            label: BURN_ADDRESS_LABELS[address.toLowerCase()] || formatAddress(address),
            network: 'base',
          });
        } catch (err) {
          console.error('[Client] Error processing Base address:', address, err);
        }
      }
    }

    const result: TokenBurnStats = {
      totalBurned: totalBurned.toString(),
      burnAddresses: allBurnAddresses,
      lastUpdated: Date.now(),
    };

    console.log('[Client] Parsed burn stats:', result);
    return result;
  } catch (error) {
    console.error('[Client] Error fetching burn stats:', error);
    return {
      totalBurned: '0',
      burnAddresses: [],
      lastUpdated: Date.now(),
    };
  }
}
