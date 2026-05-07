'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { TagInput } from '@/components/tag-input';
import { apiFetch } from '@/lib/client-api';

type KnowledgeType = 'fact' | 'decision' | 'methodology' | 'experience' | 'intent' | 'meta';

interface QuickCreateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  triggerClassName?: string;
  triggerLabel?: string;
  triggerVariant?: 'default' | 'outline' | 'secondary' | 'ghost';
  enableShortcut?: boolean;
}

const TYPE_OPTIONS: { value: KnowledgeType; label: string }[] = [
  { value: 'fact', label: '事实' },
  { value: 'decision', label: '决策' },
  { value: 'methodology', label: '方法论' },
  { value: 'experience', label: '经验' },
  { value: 'intent', label: '意图' },
  { value: 'meta', label: '元知识' },
];

function buildSummary(content: string) {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (!compact) return '手动创建的知识条目';
  return compact.length > 120 ? `${compact.slice(0, 120)}...` : compact;
}

function notifyCreated() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('kivo:knowledge-created'));
  }
}

export function QuickCreateModal({
  open,
  onOpenChange,
  onCreated,
  triggerClassName,
  triggerLabel = '新建知识',
  triggerVariant = 'default',
  enableShortcut = false,
}: QuickCreateModalProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [type, setType] = useState<KnowledgeType>('fact');
  const [domain, setDomain] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const canSave = useMemo(() => title.trim().length > 0 && content.trim().length > 0, [title, content]);

  function resetForm() {
    setTitle('');
    setContent('');
    setType('fact');
    setDomain('');
    setTags([]);
    setSaving(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      resetForm();
    }
    onOpenChange(nextOpen);
  }

  useEffect(() => {
    if (!enableShortcut) return;

    function handleShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'n') return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (target?.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select') {
        return;
      }

      event.preventDefault();
      onOpenChange(true);
    }

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [enableShortcut, onOpenChange]);

  async function handleSave() {
    if (!canSave || saving) return;

    setSaving(true);
    try {
      await apiFetch('/api/v1/knowledge', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          content: content.trim(),
          type,
          domain: domain.trim(),
          summary: buildSummary(content),
          metadata: tags.length > 0 ? { tags } : undefined,
        }),
      });

      handleOpenChange(false);
      notifyCreated();
      onCreated?.();
      toast.success('知识条目已创建');
    } catch (error) {
      const message = error instanceof Error ? error.message : '创建知识条目失败';
      toast.error(message);
      setSaving(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant={triggerVariant}
        className={triggerClassName}
        onClick={() => onOpenChange(true)}
      >
        <Plus className="h-4 w-4" />
        {triggerLabel}
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>快速创建知识条目</DialogTitle>
            <DialogDescription>
              随手记下一条事实、决策或经验，立即写入 KIVO 知识库。
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <label htmlFor="quick-create-title" className="text-sm font-medium text-slate-700 dark:text-slate-300">标题</label>
              <Input
                id="quick-create-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="知识标题"
                maxLength={120}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="quick-create-content" className="text-sm font-medium text-slate-700 dark:text-slate-300">内容</label>
              <Textarea
                id="quick-create-content"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="输入知识内容..."
                rows={6}
                className="min-h-[144px]"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">类型</label>
                <Select value={type} onValueChange={(value) => setType(value as KnowledgeType)}>
                  <SelectTrigger aria-label="知识类型">
                    <SelectValue placeholder="选择知识类型" />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label htmlFor="quick-create-domain" className="text-sm font-medium text-slate-700 dark:text-slate-300">领域</label>
                <Input
                  id="quick-create-domain"
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                  placeholder="所属领域"
                  maxLength={80}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">标签</label>
                <TagInput
                  value={tags}
                  onChange={setTags}
                  placeholder="输入标签后回车添加"
                />
              </div>
            </div>
          </div>

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
              取消
            </Button>
            <Button type="button" onClick={handleSave} disabled={!canSave || saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
