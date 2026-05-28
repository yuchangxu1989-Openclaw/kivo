'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, FileUp, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';

interface FreshStatusResponse {
  data: { isFresh: boolean; total: number; seedCount: number };
}

export function FreshInstallBanner() {
  const { data, mutate } = useApi<FreshStatusResponse>('/api/v1/status/is-fresh');
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const isFresh = data?.data?.isFresh ?? false;

  const handleClearSeed = useCallback(async () => {
    if (!confirmingClear) {
      setConfirmingClear(true);
      return;
    }

    setClearing(true);
    try {
      await apiFetch('/api/v1/seed-data', { method: 'DELETE' });
      await mutate();
      setConfirmingClear(false);
    } catch {
      // silently fail, user can retry
    } finally {
      setClearing(false);
    }
  }, [confirmingClear, mutate]);

  const handleCancelClear = useCallback(() => {
    setConfirmingClear(false);
  }, []);

  if (!isFresh) return null;

  return (
    <section className="rounded-3xl border border-amber-200/80 bg-gradient-to-br from-amber-50/80 via-orange-50/40 to-white px-5 py-4 shadow-sm sm:px-6">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
          <Sparkles className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-900">
              这些是通用模板，帮助你了解 KIVO 的功能
            </h2>
            <p className="text-sm leading-6 text-slate-600">
              当前知识库中只有预置的演示条目。导入你自己的文档后，KIVO 才会开始为你工作。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button asChild size="sm" className="gap-1.5">
              <Link href="/knowledge/import">
                <FileUp className="h-4 w-4" />
                导入你的第一份文档
              </Link>
            </Button>

            {!confirmingClear ? (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-slate-600 hover:text-red-600"
                onClick={handleClearSeed}
              >
                <Trash2 className="h-4 w-4" />
                清空通用模板
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 text-xs text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  确定要清空所有通用模板？
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleClearSeed}
                  disabled={clearing}
                >
                  {clearing ? '清空中…' : '确认清空'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCancelClear}
                  disabled={clearing}
                >
                  取消
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
