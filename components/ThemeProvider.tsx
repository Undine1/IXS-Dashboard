'use client';

import React, { createContext, useContext, useEffect } from 'react';

type ThemeContextType = {
  theme: 'dark' | 'light';
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextType>({ theme: 'dark', toggleTheme: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Always enforce dark mode at the document root
    document.documentElement.classList.add('dark');
  }, []);

  // Keep API stable for consumers; theme remains 'dark' (app is dark-only)
  const value: ThemeContextType = {
    theme: 'dark',
    toggleTheme: () => {
      // No-op to preserve dark-only UX
    },
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
