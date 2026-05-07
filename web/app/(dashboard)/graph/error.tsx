'use client';

import { useEffect } from 'react';
import { Network, RefreshCw } from 'lucide-react';

export default function GraphError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[GraphPage] Render error:', error);
  }, [error]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-50 text-red-500 dark:bg-red-900/20 dark:text-red-400">
        <Network className="h-6 w-6" />
      </div>
      <div className="text-center space-y-2">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
          图谱渲染出错
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md">
          {error.message || '图谱组件加载失败，可能是数据量过大导致。'}
        </p>
      </div>
      <button
        onClick={reset}
        className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
      >
        <RefreshCw className="h-4 w-4" />
        重新加载
      </button>
    </div>
  );
}
