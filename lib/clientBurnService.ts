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
        totalBurned: null,
        burnAddresses: [],
        lastUpdated: Date.now(),
      };
    }

    const data = await response.json();
    console.log('[Client] Received raw API response:', data);

    // Parse the API response and convert to TokenBurnStats format
    const allBurnAddresses: BurnAddress[] = [];
    let totalBurned = BigInt(0);
    let hasKnownBalance = false;
    let hasUnknownBalance = false;

    const processNetworkBalances = (
      network: 'ethereum' | 'polygon' | 'base',
      balances: Record<string, unknown>
    ) => {
      for (const [address, balance] of Object.entries(balances)) {
        const label = BURN_ADDRESS_LABELS[address.toLowerCase()] || formatAddress(address);
        if (balance === null || typeof balance === 'undefined' || balance === '') {
          hasUnknownBalance = true;
          allBurnAddresses.push({
            address,
            balance: null,
            label,
            network,
          });
          continue;
        }

        try {
          const balanceStr = String(balance);
          const balanceBigInt = BigInt(balanceStr);
          totalBurned += balanceBigInt;
          hasKnownBalance = true;

          allBurnAddresses.push({
            address,
            balance: balanceStr,
            label,
            network,
          });
        } catch (err) {
          hasUnknownBalance = true;
          allBurnAddresses.push({
            address,
            balance: null,
            label,
            network,
          });
          console.error(`[Client] Error processing ${network} address:`, address, err);
        }
      }
    };

    // Process Ethereum balances
    if (data.ethereum && typeof data.ethereum.balances === 'object') {
      console.log('[Client] Processing Ethereum balances:', data.ethereum.balances);
      processNetworkBalances('ethereum', data.ethereum.balances as Record<string, unknown>);
    }

    // Process Polygon balances
    if (data.polygon && typeof data.polygon.balances === 'object') {
      console.log('[Client] Processing Polygon balances:', data.polygon.balances);
      processNetworkBalances('polygon', data.polygon.balances as Record<string, unknown>);
    }

    // Process Base balances
    if (data.base && typeof data.base.balances === 'object') {
      console.log('[Client] Processing Base balances:', data.base.balances);
      processNetworkBalances('base', data.base.balances as Record<string, unknown>);
    }

    const totalBurnedValue = hasKnownBalance && !hasUnknownBalance ? totalBurned.toString() : null;

    const result: TokenBurnStats = {
      totalBurned: totalBurnedValue,
      burnAddresses: allBurnAddresses,
      lastUpdated: Date.now(),
    };

    console.log('[Client] Parsed burn stats:', result);
    return result;
  } catch (error) {
    console.error('[Client] Error fetching burn stats:', error);
    return {
      totalBurned: null,
      burnAddresses: [],
      lastUpdated: Date.now(),
    };
  }
}
