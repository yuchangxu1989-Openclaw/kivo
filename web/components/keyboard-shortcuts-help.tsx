'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/components/ui/utils';
import { X } from 'lucide-react';

interface ShortcutItem {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

const shortcutGroups: ShortcutGroup[] = [
  {
    title: '导航',
    items: [
      { keys: ['G', 'D'], description: '跳转到总览' },
      { keys: ['G', 'K'], description: '跳转到知识库' },
      { keys: ['G', 'G'], description: '跳转到图谱' },
      { keys: ['G', 'S'], description: '跳转到搜索' },
    ],
  },
  {
    title: '操作',
    items: [
      { keys: ['⌘', 'K'], description: '命令面板' },
      { keys: ['⌘', 'O'], description: '快速切换器' },
      { keys: ['⌘', 'N'], description: '新建知识条目' },
    ],
  },
  {
    title: '通用',
    items: [
      { keys: ['⌘', '/'], description: '显示快捷键帮助' },
      { keys: ['Esc'], description: '关闭弹窗' },
    ],
  },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-slate-200 bg-slate-50 px-1.5 font-mono text-xs font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
      {children}
    </kbd>
  );
}

interface KeyboardShortcutsHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KeyboardShortcutsHelp({ open, onOpenChange }: KeyboardShortcutsHelpProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-200 bg-white p-6 shadow-lg dark:border-slate-700 dark:bg-slate-900',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]',
            'data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
          )}
        >
          <div className="flex items-center justify-between">
            <DialogPrimitive.Title className="text-lg font-semibold text-slate-900 dark:text-white">
              键盘快捷键
            </DialogPrimitive.Title>
            <DialogPrimitive.Close className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300" aria-label="关闭">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>

          <DialogPrimitive.Description className="sr-only">
            KIVO 键盘快捷键列表
          </DialogPrimitive.Description>

          <div className="mt-4 space-y-5">
            {shortcutGroups.map((group) => (
              <div key={group.title}>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-400">
                  {group.title}
                </h3>
                <ul className="space-y-1.5">
                  {group.items.map((item) => (
                    <li
                      key={item.description}
                      className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <span className="text-slate-700 dark:text-slate-300">{item.description}</span>
                      <span className="flex items-center gap-1">
                        {item.keys.map((key, i) => (
                          <React.Fragment key={i}>
                            {i > 0 && (
                              <span className="text-xs text-slate-300 dark:text-slate-600">
                                {group.title === '导航' ? '然后' : '+'}
                              </span>
                            )}
                            <Kbd>{key}</Kbd>
                          </React.Fragment>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <p className="mt-5 text-center text-xs text-slate-400">
            在 Windows/Linux 上，⌘ 对应 Ctrl 键
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
