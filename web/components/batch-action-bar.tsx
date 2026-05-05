'use client';

import { useState } from 'react';
import { Trash2, Download, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/client-api';

interface BatchActionBarProps {
  selectedIds: Set<string>;
  onClear: () => void;
  onDeleted: () => void;
}

export function BatchActionBar({ selectedIds, onClear, onDeleted }: BatchActionBarProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const count = selectedIds.size;

  if (count === 0) return null;

  async function executeDelete() {
    setDeleting(true);
    const ids = Array.from(selectedIds);

    const results = await Promise.all(
      ids.map((id) =>
        apiFetch(`/api/v1/knowledge/${id}`, { method: 'DELETE' })
          .then(() => true)
          .catch(() => false)
      )
    );

    const success = results.filter(Boolean).length;
    const failed = results.length - success;

    if (failed === 0) {
      toast.success(`已删除 ${success} 条知识条目`);
    } else {
      toast.error(`删除完成：${success} 条成功，${failed} 条失败`);
    }

    setShowConfirm(false);
    setDeleting(false);
    onClear();
    onDeleted();
  }

  function handleExportJSON() {
    const ids = Array.from(selectedIds);
    const blob = new Blob([JSON.stringify(ids, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kivo-export-${ids.length}-items.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`已导出 ${ids.length} 条 ID`);
  }

  return (
    <div
      className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-slate-200 bg-white/95 px-5 py-3 shadow-lg backdrop-blur-sm transition-all dark:border-slate-700 dark:bg-slate-900/95"
      role="toolbar"
      aria-label="批量操作"
    >
      <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
        已选 {count} 项
      </span>

      <div className="h-5 w-px bg-slate-200 dark:bg-slate-700" />

      {showConfirm ? (
        <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-1.5 dark:bg-red-950/40" role="alert">
          <span className="text-sm text-red-700 dark:text-red-300">
            确定删除 {count} 项？不可撤销
          </span>
          <Button
            variant="destructive"
            size="sm"
            disabled={deleting}
            onClick={() => void executeDelete()}
          >
            {deleting ? '删除中…' : '确认删除'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={deleting}
            onClick={() => setShowConfirm(false)}
          >
            取消
          </Button>
        </div>
      ) : (
        <Button variant="destructive" size="sm" onClick={() => setShowConfirm(true)}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          删除
        </Button>
      )}

      <Button variant="outline" size="sm" onClick={handleExportJSON}>
        <Download className="mr-1.5 h-3.5 w-3.5" />
        导出 JSON
      </Button>

      <Button variant="ghost" size="sm" onClick={onClear}>
        <X className="mr-1.5 h-3.5 w-3.5" />
        取消选择
      </Button>
    </div>
  );
}
