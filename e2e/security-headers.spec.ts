import { expect, type Page, test } from '@playwright/test';
import { E2E_CSP, loginAndEnrol } from './fixtures';

// AC-SEC-13: headers on pages, API routes and static assets; no CSP violation on login and home, fr and ar.
const FIXED = ['x-content-type-options', 'referrer-policy', 'cross-origin-opener-policy'];

test('pages, API routes and static assets carry the security headers', async ({ request }) => {
  const page = await request.get('/fr/login');
  const html = await page.text();
  const csp = page.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-inline');
  const nonce = csp.match(/'nonce-([^']+)'/)![1]!;
  expect(html).toContain(`nonce="${nonce}"`); // Next.js put this request's nonce on its scripts
  expect(page.headers()['x-frame-options']).toBe('DENY');
  for (const h of [...FIXED, 'permissions-policy']) expect(page.headers()[h], h).toBeTruthy();

  const second = await request.get('/fr/login');
  expect(second.headers()['content-security-policy']).not.toBe(csp); // a fresh nonce per request

  const api = await request.get('/api/auth/get-session');
  expect(api.headers()['content-security-policy']).toBe(
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  for (const h of FIXED) expect(api.headers()[h], h).toBeTruthy();

  const asset = html.match(/\/_next\/static\/[^"']+\.js/)![0];
  const res = await request.get(asset);
  expect(res.status()).toBe(200);
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
});

function collectCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy|Refused to (load|execute|apply)/i.test(msg.text()))
      violations.push(msg.text());
  });
  return violations;
}

for (const locale of ['fr', 'ar'] as const) {
  test(`${locale}: no CSP violation on the login page`, async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto(`/${locale}/login`);
    await page.locator('input[name=email]').fill('someone@belgobeton.test'); // hydrated and interactive
    await page.waitForLoadState('networkidle');
    expect(violations).toEqual([]);
  });
}

test('no CSP violation on enrolment (QR code) and on the home page, in fr then ar', async ({ page }) => {
  const violations = collectCspViolations(page);
  await loginAndEnrol(page, 'fr', E2E_CSP.email);
  await page.waitForLoadState('networkidle');
  await page.goto('/ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.waitForLoadState('networkidle');
  expect(violations).toEqual([]);
});
