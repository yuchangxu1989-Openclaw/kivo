import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const COOKIE_NAME = 'kivo_session';
// UUID v4 format check
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Public API routes that do not require authentication
const PUBLIC_API_ROUTES = [
  '/api/auth',      // login, verify
  '/api/v1/search', // search is public
];

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname ?? '/';

  // Allow landing page (public marketing page)
  if (pathname === '/') {
    return NextResponse.next();
  }

  // Allow portal (login entry) and whitelisted public API routes
  if (pathname === '/portal' || PUBLIC_API_ROUTES.some(r => pathname.startsWith(r))) {
    return NextResponse.next();
  }

  // Redirect old /login to /portal
  if (pathname === '/login' || pathname === '/login/simple') {
    const portalUrl = request.nextUrl.clone();
    portalUrl.pathname = '/portal';
    return NextResponse.redirect(portalUrl);
  }

  // Allow static assets and Next.js internals
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) {
    return NextResponse.next();
  }

  // Non-public API routes require auth cookie
  if (pathname.startsWith('/api/')) {
    const sessionToken = request.cookies.get(COOKIE_NAME)?.value;
    if (!sessionToken || !UUID_RE.test(sessionToken)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.next();
  }

  const sessionToken = request.cookies.get(COOKIE_NAME)?.value;

  // Edge Runtime can't access Node.js session store.
  // Lightweight check: cookie exists and looks like a UUID.
  // Real validation happens server-side via /api/auth/verify.
  if (!sessionToken || !UUID_RE.test(sessionToken)) {
    const portalUrl = request.nextUrl.clone();
    portalUrl.pathname = '/portal';
    return NextResponse.redirect(portalUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
