'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/components/ui/utils';
import { TagBadge } from '@/components/tag-badge';

const MAX_TAGS = 10;

export interface TagInputProps {
  /** Current tags. */
  value: string[];
  /** Called when the tag list changes. */
  onChange: (tags: string[]) => void;
  /** Pool of existing tags for autocomplete suggestions. */
  suggestions?: string[];
  /** Placeholder shown when the input is empty. */
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder = '输入标签后回车添加',
  className,
  disabled,
}: TagInputProps) {
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const kw = input.trim().toLowerCase();
    if (!kw) return [];
    return suggestions
      .filter((s) => s.toLowerCase().includes(kw) && !value.includes(s))
      .slice(0, 8);
  }, [input, suggestions, value]);

  const addTag = useCallback(
    (tag: string) => {
      const trimmed = tag.trim();
      if (!trimmed) return;
      if (value.includes(trimmed)) return;
      if (value.length >= MAX_TAGS) return;
      onChange([...value, trimmed]);
      setInput('');
      setShowSuggestions(false);
      setActiveIndex(-1);
    },
    [value, onChange],
  );

  const removeTag = useCallback(
    (tag: string) => {
      onChange(value.filter((t) => t !== tag));
    },
    [value, onChange],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < filtered.length) {
        addTag(filtered[activeIndex]);
      } else {
        addTag(input);
      }
      return;
    }

    if (e.key === 'Backspace' && !input && value.length > 0) {
      removeTag(value[value.length - 1]);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
      return;
    }

    if (e.key === 'Escape') {
      setShowSuggestions(false);
      setActiveIndex(-1);
    }
  }

  // Close suggestions on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div
        className={cn(
          'flex min-h-[40px] flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background transition-colors',
          'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2',
          disabled && 'cursor-not-allowed opacity-50',
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((tag) => (
          <TagBadge
            key={tag}
            tag={tag}
            onRemove={disabled ? undefined : removeTag}
          />
        ))}
        {value.length < MAX_TAGS && (
          <input
            ref={inputRef}
            type="text"
            className="min-w-[80px] flex-1 bg-transparent outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setShowSuggestions(true);
              setActiveIndex(-1);
            }}
            onFocus={() => setShowSuggestions(true)}
            onKeyDown={handleKeyDown}
            placeholder={value.length === 0 ? placeholder : ''}
            disabled={disabled}
            aria-label="添加标签"
            aria-autocomplete="list"
            aria-expanded={showSuggestions && filtered.length > 0}
          />
        )}
        {value.length >= MAX_TAGS && (
          <span className="text-xs text-muted-foreground">已达上限 ({MAX_TAGS})</span>
        )}
      </div>

      {showSuggestions && filtered.length > 0 && (
        <ul
          className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
          role="listbox"
        >
          {filtered.map((suggestion, idx) => (
            <li
              key={suggestion}
              role="option"
              aria-selected={idx === activeIndex}
              className={cn(
                'cursor-pointer px-3 py-1.5 text-sm transition-colors',
                idx === activeIndex
                  ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                  : 'text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800',
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                addTag(suggestion);
              }}
              onMouseEnter={() => setActiveIndex(idx)}
            >
              {suggestion}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
