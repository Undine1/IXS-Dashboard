'use client';

import React, { useEffect } from 'react';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Always enforce dark mode
    document.documentElement.classList.add('dark');
  }, []);

  return <>{children}</>;
}
