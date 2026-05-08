'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { Play, Pause, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

const SPEEDS = [1, 2, 4] as const;
type Speed = (typeof SPEEDS)[number];

interface TimelinePlaybackProps {
  minTime: number;
  maxTime: number;
  value: number;
  onChange: (ts: number) => void;
  totalCount: number;
  visibleCount: number;
  relationCount: number;
}

export function TimelinePlayback({
  minTime,
  maxTime,
  value,
  onChange,
  totalCount,
  visibleCount,
  relationCount,
}: TimelinePlaybackProps) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const rafRef = useRef(0);
  const lastFrameRef = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const range = maxTime - minTime;
  // Adaptive duration: 5s for <1 week, 10s for <1 year, 15s for >1 year
  const fullDurationMs = useMemo(() => {
    const days = range / (1000 * 60 * 60 * 24);
    if (days < 7) return 5_000;
    if (days < 365) return 10_000;
    return 15_000;
  }, [range]);

  useEffect(() => {
    if (!playing) return;
    lastFrameRef.current = 0;

    const tick = (now: number) => {
      if (!lastFrameRef.current) {
        lastFrameRef.current = now;
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const delta = now - lastFrameRef.current;
      lastFrameRef.current = now;
      const step = (range / fullDurationMs) * delta * speed;
      const next = valueRef.current + step;
      if (next >= maxTime) {
        onChangeRef.current(maxTime);
        setPlaying(false);
        return;
      }
      onChangeRef.current(next);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, speed, range, maxTime, fullDurationMs]);

  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setPlaying(false);
      onChange(Number(e.target.value));
    },
    [onChange],
  );

  const reset = useCallback(() => {
    setPlaying(false);
    onChange(minTime);
  }, [onChange, minTime]);

  const togglePlay = useCallback(() => {
    if (!playing && value >= maxTime) onChange(minTime);
    setPlaying((p) => !p);
  }, [playing, value, maxTime, minTime, onChange]);

  const cycleSpeed = useCallback(() => {
    setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]);
  }, []);

  const pct = range > 0 ? ((value - minTime) / range) * 100 : 0;
  const dateLabel = new Date(value).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <div className="rounded-xl border border-slate-200/80 bg-white/95 p-4 shadow-sm dark:border-slate-700/60 dark:bg-slate-900/95">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={togglePlay}
          aria-label={playing ? '暂停' : '播放'}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>

        <div className="relative flex-1">
          <div className="absolute inset-y-0 left-0 flex items-center" style={{ width: `${pct}%` }}>
            <div className="h-1.5 w-full rounded-full bg-slate-950 dark:bg-white" />
          </div>
          <input
            type="range"
            min={minTime}
            max={maxTime}
            value={value}
            onChange={handleSliderChange}
            className="relative z-10 h-1.5 w-full cursor-pointer appearance-none bg-slate-200 dark:bg-slate-700 rounded-full
              [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-slate-950 [&::-webkit-slider-thumb]:dark:bg-white
              [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:active:cursor-grabbing"
            aria-label="时间轴位置"
          />
        </div>

        <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={reset} aria-label="重置">
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>

        <button
          type="button"
          onClick={cycleSpeed}
          className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium tabular-nums text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {speed}x
        </button>
      </div>

      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{dateLabel}</span>
        <span>
          截至此刻：{visibleCount}/{totalCount} 条知识，{relationCount} 条关联
        </span>
      </div>
    </div>
  );
}
