import axios from 'axios';
import { Transaction, BlockchainStats } from '@/types';

const API_BASE_URL = process.env.NEXT_PUBLIC_BLOCKCHAIN_API || 'https://api.etherscan.io/api';
const ETHERSCAN_API_KEY = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY || 'YourApiKeyToken';

interface EtherscanTransaction {
  hash: string;
  from: string;
  to: string;
  value: string;
  gasPrice: string;
  gasUsed?: string;
  blockNumber: string;
  timeStamp: string;
  isError: string;
}

export async function fetchLatestTransactions(
  address?: string,
  limit: number = 10
): Promise<Transaction[]> {
  try {
    const params: Record<string, string> = {
      module: 'account',
      action: 'txlist',
      sort: 'desc',
      apikey: ETHERSCAN_API_KEY,
    };

    if (address) {
      params.address = address;
    } else {
      params.address = '0x0000000000000000000000000000000000000000';
    }

    const response = await axios.get(API_BASE_URL, { params });
    const data = response.data as {
      status?: string;
      result?: unknown;
    };

    if (data.status === '1' && Array.isArray(data.result)) {
      const txs = data.result as EtherscanTransaction[];
      return txs.slice(0, limit).map((tx) => ({
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        gasPrice: tx.gasPrice,
        gasUsed: tx.gasUsed,
        blockNumber: parseInt(tx.blockNumber),
        timestamp: parseInt(tx.timeStamp),
        status: tx.isError === '0' ? 'success' : 'failed',
      }));
    }
    return [];
  } catch (error) {
    console.error('Error fetching transactions:', error);
    return [];
  }
}

export async function getBlockchainStats(
  transactions: Transaction[]
): Promise<BlockchainStats> {
  const totalTransactions = transactions.length;
  const successCount = transactions.filter((tx) => tx.status === 'success').length;
  const successRate = totalTransactions > 0 ? (successCount / totalTransactions) * 100 : 0;

  const totalValue = transactions.reduce((sum, tx) => {
    return sum + BigInt(tx.value);
  }, BigInt(0));

  const avgGasPrice =
    transactions.length > 0
      ? (
          transactions.reduce((sum, tx) => sum + BigInt(tx.gasPrice), BigInt(0)) /
          BigInt(transactions.length)
        ).toString()
      : '0';

  return {
    totalTransactions,
    averageGasPrice: avgGasPrice,
    totalValue: totalValue.toString(),
    successRate,
  };
}
