'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

export type CognitiveMode = 'focus' | 'explore' | 'overview';

interface CognitiveModeContextValue {
  mode: CognitiveMode;
  setMode: (mode: CognitiveMode) => void;
  isFocus: boolean;
  isExplore: boolean;
  isOverview: boolean;
}

const STORAGE_KEY = 'kivo-cognitive-mode';

const CognitiveModeContext = createContext<CognitiveModeContextValue>({
  mode: 'explore',
  setMode: () => {},
  isFocus: false,
  isExplore: true,
  isOverview: false,
});

export function useCognitiveMode() {
  return useContext(CognitiveModeContext);
}

function readStoredMode(): CognitiveMode {
  if (typeof window === 'undefined') return 'explore';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'focus' || stored === 'explore' || stored === 'overview') return stored;
  } catch { /* ignore */ }
  return 'explore';
}

export function CognitiveModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<CognitiveMode>('explore');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setModeState(readStoredMode());
    setHydrated(true);
  }, []);

  const setMode = useCallback((newMode: CognitiveMode) => {
    setModeState(newMode);
    try {
      localStorage.setItem(STORAGE_KEY, newMode);
    } catch { /* ignore */ }
  }, []);

  const value: CognitiveModeContextValue = {
    mode: hydrated ? mode : 'explore',
    setMode,
    isFocus: hydrated && mode === 'focus',
    isExplore: !hydrated || mode === 'explore',
    isOverview: hydrated && mode === 'overview',
  };

  return (
    <CognitiveModeContext.Provider value={value}>
      {children}
    </CognitiveModeContext.Provider>
  );
}
