import '@testing-library/jest-dom/vitest';
import { vi, afterEach, afterAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─── Test DB Isolation Guard ────────────────────────────────────────────────
// 防止 web vitest 直连 prod kivo.db。任何 test 触发的 KIVO 路径必须落在 os.tmpdir()。
// setupFiles 在每个 test 文件 top-level imports 之前重新执行,因此这里设置的
// process.env.KIVO_DB_PATH 会被 web/lib/{db,paginated-queries,auth-users}.ts
// 等模块在首次 require 时捕获到 tmp 路径,prod kivo.db 永远不会被打开。

const TMPDIR = path.resolve(os.tmpdir());

function isAllowedDbPath(p: string | undefined | null): boolean {
  if (!p) return false;
  if (p === ':memory:') return true;
  if (p.startsWith('file::memory:')) return true;
  const abs = path.resolve(p);
  return abs === TMPDIR || abs.startsWith(TMPDIR + path.sep);
}

let createdTmpRoot: string | null = null;

// 1) 守护:已显式设置的 KIVO_DB_PATH 必须指向 tmpdir,否则立即 throw
const explicit = process.env.KIVO_DB_PATH;
if (explicit && !isAllowedDbPath(explicit)) {
  throw new Error(
    `[kivo-vitest-guard] KIVO_DB_PATH must point inside os.tmpdir(); got: ${explicit}\n` +
      `  Tests must use mkdtempSync(path.join(os.tmpdir(), 'kivo-...')) for DB isolation.`,
  );
}

// 2) 默认隔离:未显式设置时,在 tmp 目录创建一个 per-process tmp DB
if (!explicit) {
  const TMP_ROOT = fs.mkdtempSync(path.join(TMPDIR, 'kivo-vitest-'));
  createdTmpRoot = TMP_ROOT;
  process.env.KIVO_DB_PATH = path.join(TMP_ROOT, 'kivo.db');
}

afterAll(() => {
  if (createdTmpRoot && fs.existsSync(createdTmpRoot)) {
    fs.rmSync(createdTmpRoot, { recursive: true, force: true });
  }
});

afterEach(() => {
  cleanup();
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [k: string]: unknown }) => {
    const React = require('react');
    return React.createElement('a', { href, ...props }, children);
  },
}));

vi.mock('@/lib/client-api', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/components/onboarding-guide-card', () => ({
  OnboardingGuideCard: ({ compact }: { compact?: boolean }) => {
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'onboarding-guide', 'data-compact': compact });
  },
}));

vi.mock('@/lib/workbench-store', () => ({
  useWorkbenchStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ hasHydrated: true, onboardingCompleted: false }),
}));
