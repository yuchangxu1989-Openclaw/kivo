'use client';

import Link from 'next/link';
import { useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, BookOpen, DatabaseZap, FilePlus2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useOnboardingKnowledgeStore } from '@/lib/onboarding-knowledge-store';
import { useWorkbenchStore } from '@/lib/workbench-store';

interface OnboardingGuideCardProps {
  title?: string;
  description?: string;
  compact?: boolean;
}

const GUIDE_STEPS = [
  '先导入一份文档或示例数据，让知识库里马上出现可浏览内容。',
  '再去搜索或知识列表，看命中结果、高亮片段和详情页。',
  '最后打开图谱与冲突页，确认关系网络和治理流程已经跑通。',
];

export function OnboardingGuideCard({
  title = '先走完第一次知识旅程',
  description = '当前还是空库状态。先完成一次导入或创建动作，KIVO 才会开始展示知识、搜索结果和图谱关系。',
  compact = false,
}: OnboardingGuideCardProps) {
  const router = useRouter();
  const completeOnboarding = useWorkbenchStore((state) => state.completeOnboarding);
  const importSamples = useOnboardingKnowledgeStore((state) => state.importSamples);

  const handleImportSamples = useCallback(() => {
    importSamples();
    completeOnboarding();
    router.push('/knowledge');
  }, [completeOnboarding, importSamples, router]);

  const actions = useMemo(
    () => [
      {
        title: '上传文档',
        description: '把 Markdown、TXT、PDF 或 EPUB 导入进来，系统会开始抽取候选知识。',
        href: '/knowledge/import',
        icon: BookOpen,
        variant: 'default' as const,
      },
      {
        title: '导入示例数据',
        description: '一键放入 6 条示例知识和 4 条关系，立刻体验搜索、列表和图谱。',
        onClick: handleImportSamples,
        icon: DatabaseZap,
        variant: 'outline' as const,
      },
      {
        title: '手动创建知识',
        description: '直接写下第一条事实、决策或方法论，马上生成可浏览条目。',
        href: '/knowledge/create',
        icon: FilePlus2,
        variant: 'outline' as const,
      },
    ],
    [handleImportSamples]
  );

  return (
    <Card className="border-indigo-200/80 bg-gradient-to-br from-white via-indigo-50/60 to-cyan-50/60 shadow-sm">
      <CardHeader className={compact ? 'pb-4' : 'pb-5'}>
        <div className="flex items-center gap-2 text-indigo-600">
          <Sparkles className="h-4 w-4" />
          <span className="text-xs font-semibold uppercase tracking-[0.2em]">首次 Onboarding</span>
        </div>
        <CardTitle className={compact ? 'text-xl' : 'text-2xl'}>{title}</CardTitle>
        <p className="max-w-3xl text-sm leading-6 text-slate-700">{description}</p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 lg:grid-cols-3">
          {actions.map((action) => {
            const Icon = action.icon;
            const content = (
              <>
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
                  <Icon className="h-5 w-5" />
                </div>
                <div className="mt-4 space-y-2">
                  <div className="flex items-center gap-2 text-slate-950">
                    <h3 className="text-base font-semibold">{action.title}</h3>
                    <ArrowRight className="h-4 w-4 text-slate-400" />
                  </div>
                  <p className="text-sm leading-6 text-slate-600">{action.description}</p>
                </div>
              </>
            );

            return action.href ? (
              <Link
                key={action.title}
                href={action.href}
                className="rounded-3xl border border-white/70 bg-white/90 p-5 transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md"
              >
                {content}
              </Link>
            ) : (
              <button
                key={action.title}
                type="button"
                onClick={action.onClick}
                className="rounded-3xl border border-white/70 bg-white/90 p-5 text-left transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md"
              >
                {content}
              </button>
            );
          })}
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-3xl border border-white/70 bg-white/80 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">建议顺序</p>
            <div className="mt-3 space-y-3">
              {GUIDE_STEPS.map((step, index) => (
                <div key={step} className="flex gap-3 rounded-2xl bg-slate-50/80 px-4 py-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
                    {index + 1}
                  </span>
                  <p className="text-sm leading-6 text-slate-700">{step}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-3xl border border-indigo-100 bg-indigo-950 px-5 py-4 text-white">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-200">完成标准</p>
            <div className="mt-3 space-y-3 text-sm leading-6 text-indigo-50/90">
              <p>导入或创建任意一条知识后，系统会自动结束 onboarding。</p>
              <p>完成后会把你带到知识列表或搜索页，让你立刻看到刚生成的内容。</p>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button asChild size="sm" variant="secondary">
                <Link href="/search">先去搜索页看看</Link>
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
