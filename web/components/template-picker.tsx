'use client';

import { useCallback, useRef, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  BookOpen, ChevronDown, ClipboardList, FileText,
  FlaskConical, GraduationCap, Lightbulb, Users,
} from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { apiFetch } from '@/lib/client-api';
import { toast } from 'sonner';

interface Template {
  id: string;
  label: string;
  icon: typeof FileText;
  type: string;
  content: string;
}

function getTemplates(): Template[] {
  const today = new Date().toISOString().slice(0, 10);
  return [
  {
    id: 'meeting-notes',
    label: '会议纪要',
    icon: Users,
    type: 'experience',
    content: `# 会议纪要

## 基本信息
- **日期**：${today}
- **参会人**：
- **会议主题**：

## 议题

### 议题 1
- 讨论内容：
- 结论：

## 决策事项
1.

## 待办事项
| 事项 | 负责人 | 截止日期 |
|------|--------|----------|
|      |        |          |
`,
  },
  {
    id: 'adr',
    label: '技术决策记录（ADR）',
    icon: Lightbulb,
    type: 'decision',
    content: `# ADR: [决策标题]

## 状态
已提议

## 背景
描述促使这个决策的上下文和问题…

## 可选方案

### 方案 A
- 描述：
- 优点：
- 缺点：

### 方案 B
- 描述：
- 优点：
- 缺点：

## 决策
我们选择 **方案 X**，因为…

## 后果
- 正面影响：
- 负面影响：
- 需要的后续行动：
`,
  },
  {
    id: 'reading-notes',
    label: '读书笔记',
    icon: BookOpen,
    type: 'experience',
    content: `# 读书笔记

## 书籍信息
- **书名**：
- **作者**：
- **阅读日期**：${today}

## 核心观点
1.
2.
3.

## 金句摘录
>

## 个人思考


## 行动项
- [ ]
`,
  },
  {
    id: 'project-retro',
    label: '项目复盘',
    icon: ClipboardList,
    type: 'methodology',
    content: `# 项目复盘

## 项目概况
- **项目名称**：
- **时间范围**：
- **复盘日期**：${today}

## 目标 vs 结果
| 目标 | 预期结果 | 实际结果 | 达成度 |
|------|----------|----------|--------|
|      |          |          |        |

## 做得好的地方
1.

## 做得差的地方
1.

## 改进措施
| 改进项 | 具体行动 | 负责人 | 截止日期 |
|--------|----------|--------|----------|
|        |          |        |          |

## 经验总结

`,
  },
  {
    id: 'learning-notes',
    label: '学习笔记',
    icon: GraduationCap,
    type: 'fact',
    content: `# 学习笔记

## 主题


## 关键概念
### 概念 1
- 定义：
- 要点：

### 概念 2
- 定义：
- 要点：

## 疑问
- [ ]

## 关联知识
- 与 [[]] 相关
- 参考资料：

## 总结

`,
  },
  {
    id: 'competitive-analysis',
    label: '竞品分析',
    icon: FlaskConical,
    type: 'methodology',
    content: `# 竞品分析

## 产品信息
- **产品名称**：
- **官网**：
- **分析日期**：${today}

## 产品定位
目标用户：
核心价值主张：

## 优势
1.

## 劣势
1.

## 功能对比
| 功能维度 | 竞品 | 我们 | 差距分析 |
|----------|------|------|----------|
|          |      |      |          |

## 启发与行动
1.
`,
  },
  ];
}

function buildSummary(content: string) {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (!compact) return '从模板创建的知识条目';
  return compact.length > 120 ? `${compact.slice(0, 120)}...` : compact;
}

interface TemplatePickerProps {
  onCreated?: () => void;
}

export function TemplatePicker({ onCreated }: TemplatePickerProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  const handleSelect = useCallback(
    async (template: Template) => {
      setCreating(template.id);
      try {
        const title = template.content
          .split('\n')
          .find((l) => l.trim().startsWith('#'))
          ?.replace(/^#+\s*/, '')
          .trim() || template.label;

        const res = await apiFetch<{ data: { id: string } }>('/api/v1/knowledge', {
          method: 'POST',
          body: JSON.stringify({
            title,
            content: template.content,
            type: template.type,
            summary: buildSummary(template.content),
          }),
        });

        setOpen(false);
        onCreated?.();

        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('kivo:knowledge-created'));
        }

        toast.success(`已从「${template.label}」模板创建`);
        router.push(`/knowledge/${res.data.id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : '创建失败';
        toast.error(message);
      } finally {
        setCreating(null);
      }
    },
    [router, onCreated],
  );

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors',
          'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
          'dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700',
        )}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="从模板创建知识条目"
      >
        <FileText className="h-4 w-4" />
        从模板创建
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          className={cn(
            'absolute right-0 top-full z-50 mt-1.5 w-72 overflow-hidden rounded-xl border shadow-lg',
            'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900',
          )}
          role="menu"
          aria-label="知识模板列表"
        >
          <div className="border-b border-slate-100 px-3 py-2 dark:border-slate-800">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              选择模板快速创建结构化知识
            </p>
          </div>
          <div className="max-h-80 overflow-y-auto py-1">
            {getTemplates().map((template) => {
              const Icon = template.icon;
              const isCreating = creating === template.id;
              return (
                <button
                  key={template.id}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors',
                    'hover:bg-slate-50 dark:hover:bg-slate-800/50',
                    isCreating && 'opacity-60 pointer-events-none',
                  )}
                  onClick={() => handleSelect(template)}
                  disabled={creating !== null}
                  role="menuitem"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-900 dark:text-white">
                      {template.label}
                    </div>
                    <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                      {isCreating ? '创建中…' : `类型：${TYPE_LABELS_MAP[template.type] ?? template.type}`}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const TYPE_LABELS_MAP: Record<string, string> = {
  fact: '事实',
  decision: '决策',
  methodology: '方法论',
  experience: '经验',
  intent: '意图',
  meta: '元知识',
};
