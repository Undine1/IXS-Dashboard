import { TokenBurnStats } from '@/types';

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
    console.log('[Client] Received burn stats:', data);
    return data;
  } catch (error) {
    console.error('[Client] Error fetching burn stats:', error);
    return {
      totalBurned: '0',
      burnAddresses: [],
      lastUpdated: Date.now(),
    };
  }
}
