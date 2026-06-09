'use client';

import { useCallback, useEffect, useState } from 'react';
import { withBasePath } from '@/lib/client-api';
import { Network, RefreshCw, AlertTriangle } from 'lucide-react';

export default function GraphError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [failCount, setFailCount] = useState(0);

  useEffect(() => {
    console.error('[GraphPage] Render error:', error);
  }, [error]);

  const handleRetry = useCallback(async () => {
    const nextCount = failCount + 1;
    setFailCount(nextCount);

    if (nextCount >= 3) {
      // Log error to backend on 3rd failure
      try {
        await fetch(withBasePath('/api/v1/graph/error-log'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: error.message || 'Unknown graph render error',
            metadata: { digest: error.digest, failCount: nextCount },
          }),
        });
      } catch {
        // Best-effort logging, don't block UI
      }
    }

    if (nextCount < 3) {
      reset();
    }
  }, [failCount, error, reset]);

  const showRefreshPrompt = failCount >= 3;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <div className={`flex h-14 w-14 items-center justify-center rounded-full ${
        showRefreshPrompt
          ? 'bg-amber-50 text-amber-500'
          : 'bg-red-50 text-red-500'
      }`}>
        {showRefreshPrompt ? (
          <AlertTriangle className="h-6 w-6" />
        ) : (
          <Network className="h-6 w-6" />
        )}
      </div>
      <div className="text-center space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">
          {showRefreshPrompt ? '图谱加载持续失败' : '图谱渲染出错'}
        </h2>
        <p className="text-sm text-slate-500 max-w-md">
          {showRefreshPrompt
            ? '已连续失败 3 次，建议刷新页面重试。如问题持续，请联系管理员。'
            : error.message || '图谱组件加载失败，可能是数据量过大导致。'}
        </p>
      </div>
      {showRefreshPrompt ? (
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          刷新页面
        </button>
      ) : (
        <button
          onClick={handleRetry}
          className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          重新加载
        </button>
      )}
    </div>
  );
}
