'use client';

import { useCallback, useState } from 'react';
import { CheckCircle2, Circle, Loader2, Rocket, Search, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/client-api';

type OnboardingStep = 1 | 2 | 3;

interface OnboardingJourneyProps {
  /** Called when the journey is complete */
  onComplete?: () => void;
}

/**
 * FR-FIX-13: First knowledge journey — 3-step onboarding card.
 * Step 1: Input knowledge (manual create)
 * Step 2: Confirm stored
 * Step 3: Search and verify retrieval
 */
export function OnboardingJourney({ onComplete }: OnboardingJourneyProps) {
  const [step, setStep] = useState<OnboardingStep>(1);
  const [loading, setLoading] = useState(false);
  const [knowledgeInput, setKnowledgeInput] = useState('');
  const [createdEntryId, setCreatedEntryId] = useState<string | null>(null);
  const [createdTitle, setCreatedTitle] = useState('');
  const [searchResult, setSearchResult] = useState<'hit' | 'miss' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Step 1: Create a knowledge entry
  const handleCreateKnowledge = useCallback(async () => {
    if (!knowledgeInput.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const title = knowledgeInput.trim().slice(0, 60);
      const res = await apiFetch<{ data: { id: string } }>('/api/v1/knowledge', {
        method: 'POST',
        body: JSON.stringify({
          content: knowledgeInput.trim(),
          title,
          type: 'fact',
          status: 'active',
        }),
      });
      setCreatedEntryId(res.data.id);
      setCreatedTitle(title);
      setStep(2);
      // Auto-advance to step 3 after a brief confirmation
      setTimeout(() => setStep(3), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败，请重试');
    } finally {
      setLoading(false);
    }
  }, [knowledgeInput]);

  // Step 3: Search and verify
  const handleSearchVerify = useCallback(async () => {
    if (!createdTitle) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ data: Array<{ id: string }> }>(
        `/api/v1/search?q=${encodeURIComponent(createdTitle)}&pageSize=5`
      );
      const entries = res.data ?? [];
      const hit = entries.some((e) => e.id === createdEntryId);
      setSearchResult(hit ? 'hit' : 'miss');
      if (hit) {
        // Mark onboarding complete
        try {
          await apiFetch('/api/v1/status/is-fresh', { method: 'POST', body: JSON.stringify({ onboardingComplete: true }) });
        } catch { /* best effort */ }
        onComplete?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '搜索失败，请重试');
    } finally {
      setLoading(false);
    }
  }, [createdTitle, createdEntryId, onComplete]);

  const stepIndicator = (s: OnboardingStep, label: string) => {
    const done = step > s || (s === 3 && searchResult === 'hit');
    const active = step === s;
    return (
      <div className="flex items-center gap-2">
        {done ? (
          <CheckCircle2 className="h-5 w-5 text-emerald-500" />
        ) : active ? (
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700 ring-2 ring-indigo-500">
            {s}
          </div>
        ) : (
          <Circle className="h-5 w-5 text-slate-300" />
        )}
        <span className={`text-sm ${active ? 'font-medium text-slate-900' : done ? 'text-emerald-600' : 'text-slate-500'}`}>
          {label}
        </span>
      </div>
    );
  };

  if (searchResult === 'hit') {
    return (
      <Card className="border-emerald-300/20 bg-emerald-950/30 shadow-lg">
        <CardContent className="flex items-center gap-4 p-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/20">
            <Rocket className="h-6 w-6 text-emerald-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-emerald-100">知识旅程完成</h3>
            <p className="text-sm text-emerald-300/80">
              你的第一条知识已成功入库并可被检索命中。系统已就绪。
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-indigo-200 bg-indigo-50/50 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2 text-indigo-600">
          <Rocket className="h-4 w-4" />
          <span className="text-xs font-medium uppercase tracking-[0.2em]">首次知识旅程</span>
        </div>
        <CardTitle className="text-xl text-slate-900">3 步体验知识管理</CardTitle>
        <p className="text-sm text-slate-500">输入一条知识 → 确认入库 → 搜索验证命中</p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Progress */}
        <div className="flex items-center gap-6">
          {stepIndicator(1, '输入知识')}
          <div className="h-px flex-1 bg-slate-200" />
          {stepIndicator(2, '确认入库')}
          <div className="h-px flex-1 bg-slate-200" />
          {stepIndicator(3, '搜索验证')}
        </div>

        {error && (
          <p className="rounded-md bg-red-900/30 px-3 py-2 text-sm text-red-300">{error}</p>
        )}

        {/* Step 1: Input */}
        {step === 1 && (
          <div className="space-y-3">
            <label className="text-sm font-medium text-slate-700">输入你的第一条知识</label>
            <Input
              placeholder="例如：KIVO 是一个自进化知识管理系统"
              value={knowledgeInput}
              onChange={(e) => setKnowledgeInput(e.target.value)}
              className="border-slate-200 bg-white text-slate-900 placeholder:text-slate-400"
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateKnowledge(); }}
            />
            <Button
              onClick={handleCreateKnowledge}
              disabled={!knowledgeInput.trim() || loading}
              className="gap-2"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              写入知识库
            </Button>
          </div>
        )}

        {/* Step 2: Confirm */}
        {step === 2 && (
          <div className="flex items-center gap-3 rounded-lg bg-emerald-900/20 p-4">
            <Loader2 className="h-5 w-5 animate-spin text-emerald-600" />
            <div>
              <p className="text-sm font-medium text-emerald-200">知识已入库</p>
              <p className="text-xs text-emerald-300/70">"{createdTitle}" 正在准备检索索引...</p>
            </div>
          </div>
        )}

        {/* Step 3: Search verify */}
        {step === 3 && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              现在搜索刚入库的知识，验证是否能被检索命中：
            </p>
            <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
              <Search className="h-4 w-4 text-slate-400" />
              <span className="text-sm text-slate-600">{createdTitle}</span>
            </div>
            <Button
              onClick={handleSearchVerify}
              disabled={loading}
              className="gap-2"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              执行搜索验证
            </Button>
            {searchResult === 'miss' && (
              <p className="text-sm text-amber-300">
                暂未命中，索引可能还在构建中。请稍等片刻后重试。
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
