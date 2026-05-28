'use client';

import { Suspense } from 'react';
import { SpaceManager } from '@/components/wiki/space-manager';

export default function WikiPage() {
  return (
    <Suspense fallback={<div className="min-h-[200px] rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">加载中…</div>}>
      <SpaceManager />
    </Suspense>
  );
}
