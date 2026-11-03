import { NextRequest, NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';
import { firstBootAllows } from './lib/first-boot';
import { contentSecurityPolicy, newNonce, securityHeaders } from './lib/security-headers';

const handleI18nRouting = createMiddleware(routing);

/**
 * Every page and API request: security headers (AC-SEC-13). Pages also get a per-request CSP nonce, passed to Next.js
 * through the request headers (next-intl forwards them) so its own scripts carry it.
 */
export default function proxy(request: NextRequest) {
  // TLS ends at the reverse proxy in deployment, so the public origin decides, not the request protocol.
  const https = (process.env.APP_BASE_URL ?? '').startsWith('https://');
  const fixed = securityHeaders({ https });

  // C2: the protected first start serves only the set-up paths; the server itself refuses to start in this mode next to real records.
  if (process.env.FIRST_BOOT === 'true' && !firstBootAllows(request.nextUrl.pathname)) {
    const refused = new NextResponse('Service en cours de première installation.', {
      status: 503,
      headers: { 'cache-control': 'no-store', 'retry-after': '3600' },
    });
    for (const [name, value] of Object.entries(fixed)) refused.headers.set(name, value);
    return refused;
  }

  if (request.nextUrl.pathname.startsWith('/api/')) {
    const response = NextResponse.next();
    response.headers.set('Content-Security-Policy', contentSecurityPolicy({ api: true }));
    for (const [name, value] of Object.entries(fixed)) response.headers.set(name, value);
    return response;
  }

  const nonce = newNonce();
  const csp = contentSecurityPolicy({ nonce, dev: process.env.NODE_ENV === 'development', https });
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);

  const response = handleI18nRouting(new NextRequest(request, { headers }));
  response.headers.set('Content-Security-Policy', csp);
  for (const [name, value] of Object.entries(fixed)) response.headers.set(name, value);
  return response;
}

export const config = {
  // Pages and API routes; static files are covered by next.config.ts headers.
  matcher: '/((?!_next/static|_next/image|favicon.ico|.*\\.[a-zA-Z0-9]+$).*)',
};
