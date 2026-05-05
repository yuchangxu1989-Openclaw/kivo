'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface WorkbenchState {
  hasHydrated: boolean;
  onboardingCompleted: boolean;
  userLabel: string;
  pendingConflictCount: number;
  setHasHydrated: (value: boolean) => void;
  completeOnboarding: () => void;
  resetOnboarding: () => void;
  setUserLabel: (value: string) => void;
  setPendingConflictCount: (value: number) => void;
}

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set) => ({
      hasHydrated: false,
      onboardingCompleted: false,
      userLabel: '',
      pendingConflictCount: 0,
      setHasHydrated: (value) => set({ hasHydrated: value }),
      completeOnboarding: () => set({ onboardingCompleted: true }),
      resetOnboarding: () => set({ onboardingCompleted: false }),
      setUserLabel: (value) => set({ userLabel: value.trim() }),
      setPendingConflictCount: (value) => set({ pendingConflictCount: Math.max(0, value) }),
    }),
    {
      name: 'kivo-workbench-preferences',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        onboardingCompleted: state.onboardingCompleted,
        userLabel: state.userLabel,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);
