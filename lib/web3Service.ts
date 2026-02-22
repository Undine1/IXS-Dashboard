import { ethers } from 'ethers';
import { BurnAddress } from '@/types';

const TOKEN_ADDRESS = process.env.NEXT_PUBLIC_TOKEN_ADDRESS || '';
const BURN_ADDRESSES = (process.env.NEXT_PUBLIC_BURN_ADDRESSES || '')
  .split(',')
  .map((addr: string) => addr.trim())
  .filter((addr: string) => addr.length > 0);

// ERC20 ABI for token balance queries
const ERC20_ABI = [
  'function balanceOf(address account) public view returns (uint256)',
  'function decimals() public view returns (uint8)',
  'function symbol() public view returns (string)',
];

const BURN_ADDRESS_LABELS: Record<string, string> = {
  '0x000000000000000000000000000000000000dead': 'Black Hole (Dead Address)',
  '0x73d7c860998ca3c01ce8c808f5577d94d545d1b4': 'IXS Contract',
  '0xec36cffd536fac67513871e114df58470696734b': 'Burn Address 3',
};

export async function fetchTokenBalancesViaWeb3(): Promise<{ totalBurned: string; burnAddresses: BurnAddress[] }> {
  try {
    if (!TOKEN_ADDRESS) {
      console.warn('[tokenBurnService] TOKEN_ADDRESS is not configured');
      return { totalBurned: '0', burnAddresses: [] };
    }

    if (BURN_ADDRESSES.length === 0) {
      console.warn('[tokenBurnService] BURN_ADDRESSES are not configured');
      return { totalBurned: '0', burnAddresses: [] };
    }

    // Use Ethereum public RPC endpoint
    const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
    const contract = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, provider);

    console.log('[tokenBurnService] Fetching token balances via Web3...');

    const burnAddressesData: BurnAddress[] = [];
    let totalBurned = BigInt(0);

    for (const address of BURN_ADDRESSES) {
      try {
        const balance = await contract.balanceOf(address);
        const balanceBigInt = BigInt(balance.toString());
        totalBurned += balanceBigInt;

        console.log(`[tokenBurnService] Balance for ${address}: ${balance.toString()}`);

        burnAddressesData.push({
          address,
          balance: balance.toString(),
          label: BURN_ADDRESS_LABELS[address.toLowerCase()] || formatAddress(address),
          network: 'ethereum',
        });
      } catch (error) {
        console.error(`[tokenBurnService] Error fetching balance for ${address}:`, error);
        burnAddressesData.push({
          address,
          balance: '0',
          label: BURN_ADDRESS_LABELS[address.toLowerCase()] || formatAddress(address),
          network: 'ethereum',
        });
      }
    }

    return {
      totalBurned: totalBurned.toString(),
      burnAddresses: burnAddressesData,
    };
  } catch (error) {
    console.error('[tokenBurnService] Error in Web3 service:', error);
    return { totalBurned: '0', burnAddresses: [] };
  }
}

function formatAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
