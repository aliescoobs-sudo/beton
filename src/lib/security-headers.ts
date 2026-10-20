/** Security headers (SPEC-platform-security §7, AC-SEC-13). Applied by src/proxy.ts on every page and API response. */

export function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
}

type CspOptions = { api: true } | { api?: false; nonce: string; dev: boolean; https: boolean };

export function contentSecurityPolicy(options: CspOptions): string {
  if (options.api) return "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
  const { nonce, dev, https } = options;
  return [
    "default-src 'self'",
    // React needs eval only in development, for its debugging tools.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // The Next.js dev overlay and indicator apply inline styles that no nonce can cover; without this they render as
    // an empty grey box. A nonce would make browsers ignore 'unsafe-inline', so development gets one or the other.
    dev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export function securityHeaders({ https }: { https: boolean }): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    ...(https ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}
