'use client';

import { X } from 'lucide-react';
import { cn } from '@/components/ui/utils';

/**
 * Deterministic hash → color palette for tag badges.
 * Each tag name always maps to the same color.
 */
const TAG_COLORS = [
  'bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100',
  'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100',
  'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100',
  'bg-purple-50 border-purple-200 text-purple-700 hover:bg-purple-100',
  'bg-rose-50 border-rose-200 text-rose-700 hover:bg-rose-100',
  'bg-cyan-50 border-cyan-200 text-cyan-700 hover:bg-cyan-100',
  'bg-orange-50 border-orange-200 text-orange-700 hover:bg-orange-100',
  'bg-indigo-50 border-indigo-200 text-indigo-700 hover:bg-indigo-100',
  'bg-teal-50 border-teal-200 text-teal-700 hover:bg-teal-100',
  'bg-pink-50 border-pink-200 text-pink-700 hover:bg-pink-100',
] as const;

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function colorForTag(tag: string): string {
  return TAG_COLORS[hashString(tag) % TAG_COLORS.length];
}

export interface TagBadgeProps {
  tag: string;
  /** Fires when the badge itself is clicked (e.g. to filter by tag). */
  onClick?: (tag: string) => void;
  /** Fires when the remove (×) button is clicked. If omitted the × is hidden. */
  onRemove?: (tag: string) => void;
  className?: string;
}

export function TagBadge({ tag, onClick, onRemove, className }: TagBadgeProps) {
  const color = colorForTag(tag);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
        color,
        onClick && 'cursor-pointer',
        className,
      )}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick ? () => onClick(tag) : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick(tag);
              }
            }
          : undefined
      }
      aria-label={onClick ? `按标签「${tag}」筛选` : undefined}
    >
      {tag}
      {onRemove && (
        <button
          type="button"
          className="ml-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full hover:bg-black/10 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(tag);
          }}
          aria-label={`移除标签「${tag}」`}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}
