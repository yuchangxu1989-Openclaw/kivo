/**
 * GET /api/v1/status/is-fresh
 * Returns { isFresh: boolean, onboardingComplete: boolean } — true when the DB contains only seed data.
 * POST /api/v1/status/is-fresh
 * Marks onboarding as complete.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getKivo } from '@/lib/kivo-engine';
import { serverError } from '@/lib/errors';
import { countEntriesBySource } from '@/lib/paginated-queries';

// In-memory onboarding state (persists across requests within same process)
const ONBOARDING_KEY = '__kivo_onboarding_complete__';
type GlobalWithOnboarding = typeof globalThis & { [ONBOARDING_KEY]?: boolean };

function isOnboardingComplete(): boolean {
  return (globalThis as GlobalWithOnboarding)[ONBOARDING_KEY] ?? false;
}

function markOnboardingComplete(): void {
  (globalThis as GlobalWithOnboarding)[ONBOARDING_KEY] = true;
}

export async function GET() {
  try {
    await getKivo(); // ensure initialized + seeded

    const { total, seedCount } = countEntriesBySource();
    // Fresh = all entries are seed data (or DB is empty)
    const isFresh = total === 0 || (seedCount > 0 && seedCount === total);

    return NextResponse.json({
      data: { isFresh, total, seedCount, onboardingComplete: isOnboardingComplete() },
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (body.onboardingComplete) {
      markOnboardingComplete();
    }
    return NextResponse.json({ data: { onboardingComplete: isOnboardingComplete() } });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
