'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  BookOpen,
  Brain,
  Database,
  LogOut,
  Menu,
  Network,
  Search,
  Settings,
  Telescope,
  UserRound,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/components/ui/utils';
import { apiFetch, BASE_PATH, withBasePath } from '@/lib/client-api';

type TopNavProps = {
  onOpenSidebar?: () => void;
};

type PrimaryTab = {
  href: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
};

type AvatarMenuItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

const primaryTabs: PrimaryTab[] = [
  { href: '/library', label: '原始资料库', description: 'Material 集合', icon: Database },
  { href: '/wiki', label: '领域 wiki', description: 'domain 知识条目', icon: BookOpen },
  { href: '/intent', label: '意图知识库', description: '偏好、纠偏、方法论', icon: Brain },
  { href: '/graph', label: '知识图谱', description: '节点与关系可视化', icon: Network },
  { href: '/search', label: '知识搜索', description: '语义搜索', icon: Search },
];

const avatarMenuItems: AvatarMenuItem[] = [
  { href: '/settings', label: '设置', icon: Settings },
  { href: '/me/understanding', label: '用户理解', icon: UserRound },
  { href: '/research', label: '调研', icon: Telescope },
];

function normalizePathname(pathname: string | null) {
  if (!pathname) return '/';
  return pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) || '/' : pathname;
}

function isTabActive(pathname: string, href: string) {
  if (href === '/library') {
    return pathname === href || pathname.startsWith('/library/') || pathname.startsWith('/wiki/materials');
  }

  if (href === '/intent') {
    return pathname === href || pathname.startsWith('/intent/') || pathname === '/knowledge' || pathname.startsWith('/knowledge/');
  }

  if (href === '/search') {
    return pathname === href || pathname.startsWith('/search/');
  }

  if (href === '/graph') {
    return pathname === href || pathname.startsWith('/graph/');
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export function TopNav({ onOpenSidebar }: TopNavProps) {
  const router = useRouter();
  const pathname = normalizePathname(usePathname());

  const logout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    window.location.href = withBasePath('/login');
  };

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="flex min-h-16 items-center gap-3 px-4 py-3 lg:px-6">
        <button
          type="button"
          onClick={onOpenSidebar}
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 lg:hidden"
          aria-label="打开学科树"
        >
          <Menu className="h-5 w-5" />
        </button>

        <Link href="/dashboard" className="group flex shrink-0 items-center gap-3 rounded-2xl pr-2" aria-label="回到 KIVO 首页">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-sm font-black tracking-tight text-slate-900 shadow-sm ring-1 ring-slate-300">
            K
          </span>
          <span className="hidden leading-tight sm:block">
            <span className="block text-sm font-black tracking-tight text-slate-950">KIVO</span>
            <span className="block text-[11px] font-medium text-slate-500">知识工作台</span>
          </span>
        </Link>

        <nav className="hidden items-center rounded-2xl border border-slate-200 bg-slate-50 p-1 xl:flex" aria-label="主导航">
          {primaryTabs.map((tab) => {
            const isActive = isTabActive(pathname, tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition-all',
                  isActive
                    ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                    : 'text-slate-600 hover:bg-white hover:text-slate-950'
                )}
                title={tab.description}
              >
                <tab.icon className={cn('h-4 w-4', isActive ? 'text-slate-900' : 'text-slate-400')} />
                <span>{tab.label}</span>
              </Link>
            );
          })}
        </nav>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-bold text-white shadow-sm hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
              aria-label="打开用户菜单"
            >
              你
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 rounded-2xl p-2">
            <DropdownMenuLabel className="px-3 text-xs text-slate-500">用户菜单</DropdownMenuLabel>
            {avatarMenuItems.map((item) => (
              <DropdownMenuItem key={item.href} asChild className="rounded-xl px-3 py-2.5">
                <Link href={item.href} className="flex w-full items-center gap-2">
                  <item.icon className="h-4 w-4 text-slate-500" />
                  <span>{item.label}</span>
                </Link>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator className="my-2 bg-slate-200" />
            <DropdownMenuItem onSelect={logout} className="rounded-xl px-3 py-2.5 text-red-600 focus:bg-red-50 focus:text-red-700">
              <LogOut className="mr-2 h-4 w-4" />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav className="flex gap-2 overflow-x-auto border-t border-slate-100 px-4 py-2 xl:hidden" aria-label="主导航">
        {primaryTabs.map((tab) => {
          const isActive = isTabActive(pathname, tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-full px-3 py-2 text-sm font-semibold transition-colors',
                isActive ? 'bg-slate-100 text-slate-900 ring-1 ring-slate-200' : 'text-slate-600 hover:bg-slate-50'
              )}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
