import '@testing-library/jest-dom/vitest';
import { vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

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
