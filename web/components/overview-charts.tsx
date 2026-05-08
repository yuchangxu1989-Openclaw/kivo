'use client';

import React, { useId, useMemo } from 'react';

// ─── Sparkline (折线迷你图) ─────────────────────────────────────────────────

interface SparklineProps {
  /** Array of numeric values */
  data: number[];
  /** SVG width */
  width?: number;
  /** SVG height */
  height?: number;
  /** Stroke color */
  color?: string;
  /** Fill gradient below line */
  fill?: boolean;
  /** Accessible label */
  label?: string;
}

export function Sparkline({
  data,
  width = 120,
  height = 32,
  color = '#6366f1',
  fill = true,
  label = '趋势图',
}: SparklineProps) {
  const instanceId = useId();

  const path = useMemo(() => {
    if (data.length < 2) return '';
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const range = max - min || 1;
    const padY = 2;
    const usableH = height - padY * 2;
    const stepX = width / (data.length - 1);

    const points = data.map((v, i) => ({
      x: i * stepX,
      y: padY + usableH - ((v - min) / range) * usableH,
    }));

    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return d;
  }, [data, width, height]);

  const fillPath = useMemo(() => {
    if (!fill || data.length < 2) return '';
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const range = max - min || 1;
    const padY = 2;
    const usableH = height - padY * 2;
    const stepX = width / (data.length - 1);

    const points = data.map((v, i) => ({
      x: i * stepX,
      y: padY + usableH - ((v - min) / range) * usableH,
    }));

    const linePart = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return `${linePart} L${width},${height} L0,${height} Z`;
  }, [data, width, height, fill]);

  if (data.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label={label}>
        <text x={width / 2} y={height / 2} textAnchor="middle" dominantBaseline="middle" className="fill-slate-400 text-[10px]">
          数据不足
        </text>
      </svg>
    );
  }

  const gradientId = `sparkline-grad-${instanceId.replace(/:/g, '')}`;

  return (
    <svg width={width} height={height} role="img" aria-label={label} className="overflow-visible">
      {fill && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.2} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
      )}
      {fill && fillPath && <path d={fillPath} fill={`url(#${gradientId})`} />}
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── MiniBarChart (迷你柱状图) ──────────────────────────────────────────────

interface MiniBarChartProps {
  /** Array of { label, value, color? } */
  data: { label: string; value: number; color?: string }[];
  /** SVG width */
  width?: number;
  /** SVG height */
  height?: number;
  /** Default bar color */
  defaultColor?: string;
  /** Accessible label */
  ariaLabel?: string;
}

export function MiniBarChart({
  data,
  width = 160,
  height = 48,
  defaultColor = '#6366f1',
  ariaLabel = '柱状图',
}: MiniBarChartProps) {
  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const barGap = 3;
  const labelH = 12;
  const usableH = height - labelH;
  const barW = data.length > 0 ? (width - barGap * (data.length - 1)) / data.length : 0;

  return (
    <svg width={width} height={height} role="img" aria-label={ariaLabel}>
      {data.map((d, i) => {
        const barH = (d.value / maxVal) * usableH;
        const x = i * (barW + barGap);
        const y = usableH - barH;
        const color = d.color || defaultColor;
        return (
          <g key={d.label}>
            <rect x={x} y={y} width={barW} height={barH} rx={2} fill={color} opacity={0.85} />
            <title>{`${d.label}: ${d.value}`}</title>
            <text
              x={x + barW / 2}
              y={height - 1}
              textAnchor="middle"
              className="fill-slate-400 dark:fill-slate-500"
              style={{ fontSize: '8px' }}
            >
              {d.label.length > 3 ? d.label.slice(0, 2) : d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── DailyActivityChart (每日活动量柱状图) ──────────────────────────────────

interface DailyActivityChartProps {
  /** Array of { date: string (YYYY-MM-DD or display label), count: number } */
  data: { date: string; count: number }[];
  width?: number;
  height?: number;
  color?: string;
}

export function DailyActivityChart({
  data,
  width = 280,
  height = 56,
  color = '#6366f1',
}: DailyActivityChartProps) {
  const maxVal = Math.max(...data.map((d) => d.count), 1);
  const barGap = 1;
  const barW = data.length > 0 ? Math.max((width - barGap * (data.length - 1)) / data.length, 2) : 2;

  return (
    <svg width={width} height={height} role="img" aria-label="每日活动量">
      {data.map((d, i) => {
        const barH = Math.max((d.count / maxVal) * height, d.count > 0 ? 2 : 0);
        const x = i * (barW + barGap);
        const y = height - barH;
        return (
          <g key={`${d.date}-${i}`}>
            <rect x={x} y={y} width={barW} height={barH} rx={1} fill={color} opacity={0.7} />
            <title>{`${d.date}: ${d.count} 条`}</title>
          </g>
        );
      })}
    </svg>
  );
}
