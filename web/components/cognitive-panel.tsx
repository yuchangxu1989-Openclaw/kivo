'use client';

import React from 'react';
import { cn } from '@/components/ui/utils';

interface CognitivePanelProps {
  /** Whether the panel is visible */
  visible: boolean;
  /** Content */
  children: React.ReactNode;
  /** Additional className */
  className?: string;
}

/**
 * Wraps content that should animate in/out based on cognitive mode.
 * Uses CSS transitions for opacity + max-height with 200ms duration.
 */
export function CognitivePanel({ visible, children, className }: CognitivePanelProps) {
  return (
    <div
      className={cn(
        'transition-all duration-200 ease-in-out overflow-hidden',
        visible ? 'opacity-100 max-h-none' : 'opacity-0 max-h-0 pointer-events-none',
        className,
      )}
      aria-hidden={!visible}
    >
      {children}
    </div>
  );
}
