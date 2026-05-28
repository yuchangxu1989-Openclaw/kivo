'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, SkipBack } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface TimelineSliderProps {
  /** Earliest date in the knowledge base (ISO string) */
  minDate: string;
  /** Latest date (defaults to now) */
  maxDate?: string;
  /** Currently selected date (ISO string) */
  value?: string;
  /** Called when user drags or animation advances */
  onChange: (isoDate: string) => void;
  /** Whether the timeline is currently playing */
  playing?: boolean;
  onPlayToggle?: () => void;
}

function dateToDay(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 86400000);
}

function dayToIso(day: number): string {
  return new Date(day * 86400000).toISOString().split('T')[0];
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function TimelineSlider({
  minDate,
  maxDate,
  value,
  onChange,
  playing: externalPlaying,
  onPlayToggle: externalPlayToggle,
}: TimelineSliderProps) {
  const effectiveMax = maxDate || new Date().toISOString();
  const minDay = dateToDay(minDate);
  const maxDay = dateToDay(effectiveMax);
  const totalDays = Math.max(1, maxDay - minDay);

  const [internalPlaying, setInternalPlaying] = useState(false);
  const playing = externalPlaying ?? internalPlaying;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const currentDay = value ? dateToDay(value) : maxDay;
  const sliderValue = currentDay - minDay;

  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const day = minDay + parseInt(e.target.value, 10);
      onChange(dayToIso(day));
    },
    [minDay, onChange],
  );

  const handlePlayToggle = useCallback(() => {
    if (externalPlayToggle) {
      externalPlayToggle();
    } else {
      setInternalPlaying((p) => !p);
    }
  }, [externalPlayToggle]);

  const handleReset = useCallback(() => {
    onChange(dayToIso(minDay));
    if (!externalPlayToggle) setInternalPlaying(false);
  }, [minDay, onChange, externalPlayToggle]);

  // Auto-play animation: advance one day every 500ms
  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(() => {
        const next = currentDay + 1;
        if (next > maxDay) {
          // Reached end, stop playing
          if (!externalPlayToggle) setInternalPlaying(false);
          if (intervalRef.current) clearInterval(intervalRef.current);
          return;
        }
        onChange(dayToIso(next));
      }, 500);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playing, currentDay, maxDay, onChange, externalPlayToggle]);

  if (totalDays <= 1) return null;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white/90 px-4 py-2.5 shadow-sm">
      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0"
        onClick={handleReset}
        title="回到起点"
      >
        <SkipBack className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0"
        onClick={handlePlayToggle}
        title={playing ? '暂停' : '播放'}
      >
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </Button>
      <span className="min-w-[5rem] text-xs text-muted-foreground">
        {formatDate(dayToIso(minDay))}
      </span>
      <input
        type="range"
        min={0}
        max={totalDays}
        step={1}
        value={sliderValue}
        onChange={handleSliderChange}
        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-slate-200 accent-indigo-500"
        aria-label="时间轴滑动条"
      />
      <span className="min-w-[5rem] text-right text-xs text-muted-foreground">
        {formatDate(dayToIso(maxDay))}
      </span>
      <span className="min-w-[6rem] text-center text-xs font-medium text-indigo-600">
        {formatDate(value || effectiveMax)}
      </span>
    </div>
  );
}
