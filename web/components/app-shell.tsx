'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { cn } from '@/components/ui/utils';
import {
  Activity,
  BookMarked,
  BookOpen,
  ChevronDown,
  Gauge,
  KeyRound,
  Library,
  Menu,
  Network,
  Search,
  Settings,
  Telescope,
  X,
  LogOut,
} from 'lucide-react';
import { apiFetch, BASE_PATH, withBasePath } from '@/lib/client-api';
import { QuickCreateModal } from '@/components/quick-create-modal';
import { useKeyboardShortcuts } from '@/components/keyboard-shortcuts-provider';
import { useCognitiveMode } from '@/contexts/cognitive-mode-context';

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }> };
type NavGroup = { label: string; items: NavItem[] };

const navGroups: NavGroup[] = [
  {
    label: '总览',
    items: [
      { href: '/dashboard', label: '仪表盘', icon: Gauge },
    ],
  },
  {
    label: '知识库',
    items: [
      { href: '/knowledge', label: '意图知识库', icon: BookOpen },
      { href: '/wiki', label: '领域知识库', icon: Library },
      { href: '/search', label: '知识搜索', icon: Search },
      { href: '/graph', label: '知识图谱', icon: Network },
    ],
  },
  {
    label: '工作台',
    items: [
      { href: '/research', label: '调研队列', icon: Telescope },
    ],
  },
  {
    label: '系统',
    items: [
      { href: '/activity', label: '操作日志', icon: Activity },
    ],
  },
];

const settingsNavItems: NavItem[] = [
  { href: '/settings/security', label: '密码修改', icon: KeyRound },
  { href: '/settings/dictionary', label: '系统词典管理', icon: BookMarked },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const normalizedPathname = pathname?.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) || '/' : pathname;
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [quickCreateOpen, setQuickCreateOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [collapsedGroups, setCollapsedGroups] = React.useState<Record<string, boolean>>({});
  const { setCommandPaletteOpen } = useKeyboardShortcuts();
  const { isFocus } = useCognitiveMode();

  useEffect(() => {
    setSidebarOpen(false);
  }, [normalizedPathname]);

  const toggleGroup = (label: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [label]: !prev[label] }));
  };

  const isItemActive = (href: string) =>
    normalizedPathname === href || normalizedPathname?.startsWith(`${href}/`);

  return (
    <div className="flex h-screen overflow-hidden bg-white text-slate-900">
      {sidebarOpen && <div className="fixed inset-0 z-40 bg-black/20 md:hidden" onClick={() => setSidebarOpen(false)} />}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 overflow-y-auto border-r border-slate-200 bg-slate-50 text-slate-900 shadow-sm transition-all duration-200',
          'md:relative md:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
          sidebarCollapsed ? 'w-16' : 'w-64',
          isFocus && 'md:w-0 md:min-w-0 md:border-0 md:overflow-hidden md:p-0'
        )}
      >
        <div className="flex h-14 items-center border-b border-slate-200 px-4">
          {!sidebarCollapsed && (
            <Link href="/dashboard" className="flex flex-col">
              <span className="text-lg font-bold tracking-tight text-slate-900">KIVO</span>
              <span className="-mt-1 text-[10px] text-indigo-600">Knowledge Intelligence</span>
            </Link>
          )}
          <button
            className={cn('text-slate-500 hover:text-slate-700 hidden md:block', sidebarCollapsed ? 'mx-auto' : 'ml-auto')}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
          >
            {sidebarCollapsed ? <Menu className="h-5 w-5" /> : <X className="h-5 w-5" />}
          </button>
          <button className="ml-auto text-slate-500 hover:text-slate-700 md:hidden" onClick={() => setSidebarOpen(false)} aria-label="关闭侧边栏">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className={cn('space-y-4 pb-20', sidebarCollapsed ? 'p-2' : 'p-3')}>
          {!sidebarCollapsed && (
            <QuickCreateModal
              open={quickCreateOpen}
              onOpenChange={setQuickCreateOpen}
              triggerLabel="新建知识"
              triggerClassName="w-full justify-start gap-2 rounded-xl bg-indigo-500 px-3 py-2.5 text-sm font-semibold text-white hover:bg-indigo-400"
              enableShortcut
            />
          )}

          {navGroups.map((group) => {
            const isGroupCollapsed = collapsedGroups[group.label] ?? false;
            const hasActiveItem = group.items.some((item) => isItemActive(item.href));
            return (
              <div key={group.label} className="space-y-1">
                {!sidebarCollapsed && (
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.label)}
                    className="flex w-full items-center justify-between px-3 py-1"
                  >
                    <p className={cn(
                      'text-[10px] font-medium uppercase tracking-[0.24em]',
                      hasActiveItem ? 'text-indigo-600' : 'text-slate-500'
                    )}>{group.label}</p>
                    <ChevronDown className={cn(
                      'h-3 w-3 text-slate-400 transition-transform',
                      isGroupCollapsed && '-rotate-90'
                    )} />
                  </button>
                )}
                {(!isGroupCollapsed || sidebarCollapsed) && (
                  <div className="space-y-0.5">
                    {group.items.map((item) => {
                      const isActive = isItemActive(item.href);
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          aria-current={isActive ? 'page' : undefined}
                          title={sidebarCollapsed ? item.label : undefined}
                          className={cn(
                            'flex items-center rounded-xl text-sm font-medium transition-all duration-200',
                            sidebarCollapsed ? 'justify-center p-2.5' : 'gap-3 px-3 py-2',
                            isActive ? 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                          )}
                        >
                          <item.icon className={cn('h-4 w-4', isActive ? 'text-indigo-600' : 'text-slate-500')} />
                          {!sidebarCollapsed && <span>{item.label}</span>}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className={cn('absolute bottom-0 left-0 right-0 border-t border-slate-200 bg-slate-50', sidebarCollapsed ? 'p-2' : 'p-3 space-y-2')}>
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            className={cn(
              'flex w-full items-center rounded-xl text-sm font-medium text-slate-600 transition-all hover:bg-slate-100 hover:text-slate-900',
              sidebarCollapsed ? 'justify-center p-2.5' : 'gap-3 px-3 py-2.5'
            )}
            title={sidebarCollapsed ? '设置' : undefined}
            aria-expanded={settingsOpen}
          >
            <Settings className="h-4 w-4 text-slate-500" />
            {!sidebarCollapsed && <span>设置</span>}
          </button>
          {settingsOpen && !sidebarCollapsed && (
            <div className="space-y-1 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
              {settingsNavItems.map((item) => {
                const isActive = isItemActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium transition-colors',
                      isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
                    )}
                  >
                    <item.icon className="h-3.5 w-3.5" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          )}
          <p className="text-center text-[10px] text-slate-500">{sidebarCollapsed ? 'v0.1' : 'v0.1.0'}</p>
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center gap-4 border-b border-slate-200 bg-white px-4 shadow-sm">
          <button className="md:hidden" onClick={() => setSidebarOpen(true)} aria-label="打开侧边栏">
            <Menu className="h-5 w-5 text-slate-600" />
          </button>
          <button
            onClick={() => setCommandPaletteOpen(true)}
            className="ml-auto flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <Search className="h-4 w-4" />
            <span className="hidden sm:inline">搜索知识...</span>
            <kbd className="ml-2 hidden rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500 sm:inline">
              ⌘K
            </kbd>
          </button>
          <button
            onClick={async () => {
              await apiFetch('/api/auth/logout', { method: 'POST' });
              window.location.href = withBasePath('/login');
            }}
            className="flex items-center gap-1.5 rounded-xl px-2 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-700"
            aria-label="退出登录"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">退出</span>
          </button>
        </header>

        <main className="animate-fade-in flex-1 overflow-y-auto bg-white p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
