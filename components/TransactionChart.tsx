'use client';

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Transaction } from '@/types';

interface TransactionChartProps {
  transactions: Transaction[];
}

export default function TransactionChart({ transactions }: TransactionChartProps) {
  const chartData = transactions
    .slice()
    .reverse()
    .map((tx) => ({
      timestamp: new Date(tx.timestamp * 1000).toLocaleTimeString(),
      value: parseInt(tx.value) / 1e18, // Convert Wei to ETH
      gasPrice: parseInt(tx.gasPrice) / 1e9, // Convert to Gwei
    }));

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Transaction Trends
      </h2>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="timestamp" stroke="#6b7280" />
          <YAxis stroke="#6b7280" />
          <Tooltip
            contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '0.5rem' }}
            labelStyle={{ color: '#fff' }}
          />
          <Legend />
          <Line type="monotone" dataKey="value" stroke="#3b82f6" name="Value (ETH)" />
          <Line type="monotone" dataKey="gasPrice" stroke="#10b981" name="Gas Price (Gwei)" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
