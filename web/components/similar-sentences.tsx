'use client';

import { cn } from '@/components/ui/utils';
import { parseSimilarSentences } from '@/lib/parse-similar-sentences';

interface SimilarSentenceTagsProps {
  /** Raw similar_sentences from API — string[], JSON string, or null */
  similarSentences: unknown;
  className?: string;
}

/**
 * Inline tag/chip display for similar sentences.
 * Used in list views — compact, wrapping layout.
 */
export function SimilarSentenceTags({ similarSentences, className }: SimilarSentenceTagsProps) {
  const sentences = parseSimilarSentences(similarSentences);

  if (sentences.length === 0) {
    return (
      <span className={cn('text-xs text-muted-foreground/60 italic', className)}>
        暂无相似句
      </span>
    );
  }

  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {sentences.map((sentence, i) => (
        <span
          key={i}
          className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:border-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
        >
          {sentence}
        </span>
      ))}
    </div>
  );
}

interface SimilarSentenceListProps {
  /** Raw similar_sentences from API — string[], JSON string, or null */
  similarSentences: unknown;
  className?: string;
}

/**
 * Block-level display for similar sentences.
 * Used in detail views — numbered list with bullets.
 */
export function SimilarSentenceList({ similarSentences, className }: SimilarSentenceListProps) {
  const sentences = parseSimilarSentences(similarSentences);

  if (sentences.length === 0) {
    return (
      <p className={cn('text-sm text-muted-foreground/60 italic', className)}>
        暂无相似句
      </p>
    );
  }

  return (
    <ul className={cn('space-y-2', className)}>
      {sentences.map((sentence, i) => (
        <li key={i} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100 text-[10px] font-semibold text-blue-700 dark:bg-blue-900/60 dark:text-blue-300">
            {i + 1}
          </span>
          <span className="leading-relaxed">{sentence}</span>
        </li>
      ))}
    </ul>
  );
}
