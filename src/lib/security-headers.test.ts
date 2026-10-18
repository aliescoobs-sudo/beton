import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, newNonce, securityHeaders } from './security-headers';

const directives = (csp: string) =>
  Object.fromEntries(
    csp
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .map(([k, ...v]) => [k, v]),
  );

describe('contentSecurityPolicy (AC-SEC-13)', () => {
  it('allows scripts only with this request’s nonce (strict-dynamic), no eval in production', () => {
    const d = directives(contentSecurityPolicy({ nonce: 'abc123', dev: false, https: true }));
    expect(d['script-src']).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'none'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['form-action']).toEqual(["'self'"]);
    expect(d['img-src']).toContain('data:'); // enrolment QR code is a data: URL
    expect(d['upgrade-insecure-requests']).toEqual([]);
  });

  it('adds eval only in development (React debugging) and no upgrade on plain http', () => {
    const d = directives(contentSecurityPolicy({ nonce: 'n', dev: true, https: false }));
    expect(d['script-src']).toContain("'unsafe-eval'");
    expect(d).not.toHaveProperty('upgrade-insecure-requests');
  });

  it('API responses get a CSP that allows nothing to load', () => {
    expect(contentSecurityPolicy({ api: true })).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
  });
});

describe('securityHeaders', () => {
  it('sets the fixed hardening headers', () => {
    const h = securityHeaders({ https: false });
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('same-origin');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Permissions-Policy']).toMatch(/camera=\(\)/);
    expect(h).not.toHaveProperty('Strict-Transport-Security');
  });

  it('adds HSTS only when served over https', () => {
    expect(securityHeaders({ https: true })['Strict-Transport-Security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });
});

describe('newNonce', () => {
  it('is random, base64, at least 128 bits', () => {
    const a = newNonce();
    expect(a).not.toBe(newNonce());
    expect(Buffer.from(a, 'base64').length).toBeGreaterThanOrEqual(16);
  });
});
