'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { sampleKnowledgeEntries, sampleKnowledgeRelations, type LocalKnowledgeEntry, type LocalKnowledgeRelation } from '@/data/sample-knowledge';

interface ManualKnowledgeInput {
  title: string;
  content: string;
  summary?: string;
  type?: LocalKnowledgeEntry['type'];
  domain?: string;
}

interface OnboardingKnowledgeState {
  hasHydrated: boolean;
  entries: LocalKnowledgeEntry[];
  relations: LocalKnowledgeRelation[];
  hasImportedSamples: boolean;
  setHasHydrated: (value: boolean) => void;
  importSamples: () => LocalKnowledgeEntry[];
  createManualKnowledge: (input: ManualKnowledgeInput) => LocalKnowledgeEntry;
  reset: () => void;
}

function nowIso() {
  return new Date().toISOString();
}

function buildSummary(content: string, fallback?: string) {
  const trimmedFallback = fallback?.trim();
  if (trimmedFallback) return trimmedFallback;

  const compact = content.replace(/\s+/g, ' ').trim();
  if (!compact) return '手动创建的知识条目';
  return compact.length > 120 ? `${compact.slice(0, 120)}...` : compact;
}

export const useOnboardingKnowledgeStore = create<OnboardingKnowledgeState>()(
  persist(
    (set) => ({
      hasHydrated: false,
      entries: [],
      relations: [],
      hasImportedSamples: false,
      setHasHydrated: (value) => set({ hasHydrated: value }),
      importSamples: () => {
        set(() => ({
          entries: sampleKnowledgeEntries,
          relations: sampleKnowledgeRelations,
          hasImportedSamples: true,
        }));
        return sampleKnowledgeEntries;
      },
      createManualKnowledge: (input) => {
        const timestamp = nowIso();
        const title = input.title.trim() || '未命名知识';
        const content = input.content.trim();
        const entry: LocalKnowledgeEntry = {
          id: `manual-knowledge-${crypto.randomUUID()}`,
          type: input.type ?? 'fact',
          title,
          content,
          summary: buildSummary(content, input.summary),
          domain: input.domain?.trim() || 'manual',
          status: 'active',
          confidence: 0.82,
          source: {
            type: 'manual',
            reference: 'KIVO 首次 Onboarding / 手动创建',
          },
          createdAt: timestamp,
          updatedAt: timestamp,
          version: 1,
        };

        set((state) => ({
          entries: [entry, ...state.entries],
        }));

        return entry;
      },
      reset: () => set({ entries: [], relations: [], hasImportedSamples: false }),
    }),
    {
      name: 'kivo-onboarding-knowledge',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        entries: state.entries,
        relations: state.relations,
        hasImportedSamples: state.hasImportedSamples,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);
