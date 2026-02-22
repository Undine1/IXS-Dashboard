import { BurnAddress, TokenBurnStats } from '@/types';

const BURN_ADDRESS_LABELS: Record<string, string> = {
  '0x000000000000000000000000000000000000dead': 'Black Hole (Dead Address)',
  '0x73d7c860998ca3c01ce8c808f5577d94d545d1b4': 'IXS Contract',
  '0xec36cffd536fac67513871e114df58470696734b': 'Burn Address 3',
  '0x1ba17c639bdaecd8dc4aac37df062d17ee43a1b8': 'Polygon IXS Contract',
};

export async function fetchTokenBurnStats(): Promise<TokenBurnStats> {
  try {
    console.log('[tokenBurnService] Fetching burn stats from API...');

    const response = await fetch('/api/burnStats');

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    console.log('[tokenBurnService] Raw API response:', data);

    const allBurnAddresses: BurnAddress[] = [];
    let totalBurned = BigInt(0);

    // Process Ethereum balances
    if (data.ethereum && typeof data.ethereum.balances === 'object') {
      console.log('[tokenBurnService] Processing Ethereum balances:', data.ethereum.balances);
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
          console.error('[tokenBurnService] Error processing Ethereum address:', address, err);
        }
      }
    }

    // Process Polygon balances
    if (data.polygon && typeof data.polygon.balances === 'object') {
      console.log('[tokenBurnService] Processing Polygon balances:', data.polygon.balances);
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
          console.error('[tokenBurnService] Error processing Polygon address:', address, err);
        }
      }
    }

    console.log('[tokenBurnService] Final result:', {
      totalBurned: totalBurned.toString(),
      addressCount: allBurnAddresses.length,
      addresses: allBurnAddresses,
    });

    return {
      totalBurned: totalBurned.toString(),
      burnAddresses: allBurnAddresses,
      lastUpdated: Date.now(),
    };
  } catch (error) {
    console.error('[tokenBurnService] Error fetching token burn stats:', error);
    return {
      totalBurned: null,
      burnAddresses: [],
      lastUpdated: Date.now(),
    };
  }
}

function formatAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
