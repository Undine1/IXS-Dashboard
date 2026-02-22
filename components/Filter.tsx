'use client';

import { FilterOptions } from '@/types';

interface FilterProps {
  onFilterChange: (filters: FilterOptions) => void;
}

export default function Filter({ onFilterChange }: FilterProps) {
  const handleStatusChange = (status: string) => {
    onFilterChange({
      status: status === 'all' ? undefined : (status as 'pending' | 'success' | 'failed'),
    });
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Filters</h2>
      
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Transaction Status
          </label>
          <div className="flex gap-3">
            {['all', 'success', 'failed', 'pending'].map((status) => (
              <button
                key={status}
                onClick={() => handleStatusChange(status)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  status === 'all'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
