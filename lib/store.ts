import { create } from 'zustand';
import { Transaction, FilterOptions } from '@/types';

interface TransactionStore {
  transactions: Transaction[];
  filters: FilterOptions;
  loading: boolean;
  error: string | null;
  setTransactions: (transactions: Transaction[]) => void;
  setFilters: (filters: FilterOptions) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  getFilteredTransactions: () => Transaction[];
}

export const useTransactionStore = create<TransactionStore>((set, get) => ({
  transactions: [],
  filters: {},
  loading: false,
  error: null,
  setTransactions: (transactions) => set({ transactions }),
  setFilters: (filters) => set({ filters }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  getFilteredTransactions: () => {
    const { transactions, filters } = get();
    return transactions.filter((tx) => {
      if (filters.status && tx.status !== filters.status) return false;
      return true;
    });
  },
}));
