'use client';

import React from 'react';
import { cn } from '@/components/ui/utils';
import { useCognitiveMode, type CognitiveMode } from '@/contexts/cognitive-mode-context';
import { Focus, Compass, BarChart3 } from 'lucide-react';

const modes: { value: CognitiveMode; label: string; icon: typeof Focus; title: string }[] = [
  { value: 'focus', label: '聚焦', icon: Focus, title: '聚焦模式 (Ctrl+1)' },
  { value: 'explore', label: '探索', icon: Compass, title: '探索模式 (Ctrl+2)' },
  { value: 'overview', label: '总览', icon: BarChart3, title: '总览模式 (Ctrl+3)' },
];

export function CognitiveModeSwitcher() {
  const { mode, setMode } = useCognitiveMode();

  return (
    <div
      className="flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-800"
      role="radiogroup"
      aria-label="认知负荷模式"
    >
      {modes.map((m) => {
        const Icon = m.icon;
        const active = mode === m.value;
        return (
          <button
            key={m.value}
            role="radio"
            aria-checked={active}
            title={m.title}
            onClick={() => setMode(m.value)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-200',
              active
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white'
                : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}
