'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { cn } from '@/components/ui/utils';
import {
  LayoutDashboard,
  BookOpen,
  Search,
  AlertTriangle,
  Menu,
  X,
  LogOut,
  Activity,
  FlaskConical,
  Upload,
  BookMarked,
  Network,
  Clock,
} from 'lucide-react';
import { apiFetch, BASE_PATH, withBasePath } from '@/lib/client-api';
import { useWorkbenchStore } from '@/lib/workbench-store';
import { QuickCreateModal } from '@/components/quick-create-modal';
import { ThemeToggle } from '@/components/theme-toggle';
import { useKeyboardShortcuts } from '@/components/keyboard-shortcuts-provider';
import { CognitiveModeSwitcher } from '@/components/cognitive-mode-switcher';
import { useCognitiveMode } from '@/contexts/cognitive-mode-context';

const primaryNavItems = [
  { href: '/dashboard', label: '总览', icon: LayoutDashboard },
  { href: '/knowledge', label: '知识库', icon: BookOpen },
  { href: '/graph', label: '图谱', icon: Network },
  { href: '/search', label: '搜索', icon: Search },
  { href: '/conflicts', label: '冲突', icon: AlertTriangle },
  { href: '/timeline', label: '时间线', icon: Clock },
  { href: '/research', label: '调研', icon: FlaskConical },
  { href: '/activity', label: '活动', icon: Activity },
] as const;

const secondaryNavItems = [
  { href: '/knowledge/import', label: '导入', icon: Upload },
  { href: '/settings/dictionary', label: '系统字典', icon: BookMarked },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const normalizedPathname = pathname?.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) || '/' : pathname;
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [quickCreateOpen, setQuickCreateOpen] = React.useState(false);
  const pendingConflictCount = useWorkbenchStore((state) => state.pendingConflictCount);
  const setPendingConflictCount = useWorkbenchStore((state) => state.setPendingConflictCount);
  const { setCommandPaletteOpen } = useKeyboardShortcuts();
  const { isFocus } = useCognitiveMode();

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ data: Array<{ status: string }>; meta?: unknown }>('/api/v1/conflicts?status=pending')
      .then((payload) => {
        if (!cancelled) {
          const items = Array.isArray(payload.data) ? payload.data : [];
          setPendingConflictCount(items.filter((item) => item.status === 'unresolved').length);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPendingConflictCount(0);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [setPendingConflictCount]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [normalizedPathname]);

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 dark:bg-slate-950">
      {sidebarOpen && <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 overflow-y-auto border-r border-slate-800 bg-slate-950 text-white transition-all duration-200',
          'md:relative md:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
          sidebarCollapsed ? 'w-16' : 'w-72',
          isFocus && 'md:w-0 md:min-w-0 md:border-0 md:overflow-hidden md:p-0'
        )}
      >
        <div className="flex h-14 items-center border-b border-slate-800 px-4">
          {!sidebarCollapsed && (
            <Link href="/dashboard" className="flex flex-col">
              <span className="text-lg font-bold tracking-tight text-white">KIVO</span>
              <span className="-mt-1 text-[10px] text-slate-500">Knowledge Intelligence</span>
            </Link>
          )}
          <button
            className={cn('text-slate-400 hover:text-white hidden md:block', sidebarCollapsed ? 'mx-auto' : 'ml-auto')}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
          >
            {sidebarCollapsed ? <Menu className="h-5 w-5" /> : <X className="h-5 w-5" />}
          </button>
          <button className="ml-auto text-slate-400 hover:text-white md:hidden" onClick={() => setSidebarOpen(false)} aria-label="关闭侧边栏">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className={cn('space-y-6 pb-20', sidebarCollapsed ? 'p-2' : 'p-3')}>
          <div className="space-y-3">
            {!sidebarCollapsed && (
              <QuickCreateModal
                open={quickCreateOpen}
                onOpenChange={setQuickCreateOpen}
                triggerLabel="新建知识"
                triggerClassName="w-full justify-start gap-2 rounded-xl bg-indigo-500 px-3 py-2.5 text-sm font-semibold text-white hover:bg-indigo-400"
                enableShortcut
              />
            )}

            <div className="space-y-1.5">
              {!sidebarCollapsed && <p className="px-3 text-[10px] font-medium uppercase tracking-[0.24em] text-slate-500">工作台</p>}
              {primaryNavItems.map((item) => {
                const isActive = normalizedPathname === item.href || normalizedPathname?.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    title={sidebarCollapsed ? item.label : undefined}
                    className={cn(
                      'flex items-center rounded-xl text-sm font-medium transition-colors',
                      sidebarCollapsed ? 'justify-center p-2.5' : 'gap-3 px-3 py-2.5',
                      isActive ? 'bg-white text-slate-950' : 'text-slate-300 hover:bg-slate-900 hover:text-white'
                    )}
                  >
                    <div className="relative flex items-center">
                      <item.icon className={cn('h-4 w-4', isActive ? 'text-slate-950' : 'text-slate-400')} />
                      {item.label === '冲突' && pendingConflictCount > 0 && (
                        <span className="absolute -right-3 -top-2 inline-flex min-w-5 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[10px] font-semibold text-white">
                          {pendingConflictCount}
                        </span>
                      )}
                    </div>
                    {!sidebarCollapsed && <span>{item.label}</span>}
                  </Link>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            {!sidebarCollapsed && <p className="px-3 text-[10px] font-medium uppercase tracking-[0.24em] text-slate-500">管理</p>}
            {secondaryNavItems.map((item) => {
              const isActive = normalizedPathname === item.href || normalizedPathname?.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? 'page' : undefined}
                  title={sidebarCollapsed ? item.label : undefined}
                  className={cn(
                    'flex items-center rounded-xl text-sm font-medium transition-colors',
                    sidebarCollapsed ? 'justify-center p-2.5' : 'gap-3 px-3 py-2.5',
                    isActive ? 'bg-white text-slate-950' : 'text-slate-300 hover:bg-slate-900 hover:text-white'
                  )}
                >
                  <item.icon className={cn('h-4 w-4', isActive ? 'text-slate-950' : 'text-slate-400')} />
                  {!sidebarCollapsed && <span>{item.label}</span>}
                </Link>
              );
            })}
          </div>

        </nav>

        <div className={cn('absolute bottom-0 left-0 right-0 border-t border-slate-800 bg-slate-950/95 backdrop-blur', sidebarCollapsed ? 'p-2' : 'p-3 space-y-2')}>
          {/* ThemeToggle removed - light theme only */}
          <p className="text-center text-[10px] text-slate-500">{sidebarCollapsed ? 'v0.1' : 'v0.1.0'}</p>
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center gap-4 border-b bg-white px-4 shadow-sm dark:bg-slate-900 dark:border-slate-800">
          <button className="md:hidden" onClick={() => setSidebarOpen(true)} aria-label="打开侧边栏">
            <Menu className="h-5 w-5 text-slate-600" />
          </button>
          {/* CognitiveModeSwitcher removed - over-designed, only overview mode needed */}
          <button
            onClick={() => setCommandPaletteOpen(true)}
            className="ml-auto flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent"
          >
            <Search className="h-4 w-4" />
            <span className="hidden sm:inline">搜索知识...</span>
            <kbd className="ml-2 hidden rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 sm:inline dark:border-slate-700 dark:bg-slate-800">
              ⌘K
            </kbd>
          </button>
          <button
            onClick={async () => {
              await apiFetch('/api/auth/logout', { method: 'POST' });
              window.location.href = withBasePath('/login');
            }}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent"
            aria-label="退出登录"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">退出</span>
          </button>
        </header>

        <main className="animate-fade-in flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
