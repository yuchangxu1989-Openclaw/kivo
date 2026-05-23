'use client';

import Link from 'next/link';
import { KeyRound, BookMarked } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const settingsItems = [
  {
    href: '/settings/security',
    label: '密码修改',
    description: '修改登录密码，保障账户安全。',
    icon: KeyRound,
  },
  {
    href: '/settings/dictionary',
    label: '系统词典管理',
    description: '管理知识提取和语义匹配使用的领域词典。',
    icon: BookMarked,
  },
];

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">设置</h1>
        <p className="text-sm text-slate-500">系统配置与安全管理</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {settingsItems.map((item) => (
          <Link key={item.href} href={item.href} className="block">
            <Card className="border-slate-200 bg-white shadow-sm transition-colors hover:border-indigo-200 hover:bg-indigo-50/30">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50">
                    <item.icon className="h-4 w-4 text-indigo-600" />
                  </div>
                  <CardTitle className="text-base text-slate-900">{item.label}</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-slate-600">{item.description}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
