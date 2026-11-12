import { expect, test } from '@playwright/test';

// The browser side of the staging gate. Playwright's httpCredentials answer a 401 Basic CHALLENGE, like the prompt of a real browser, and are then reused
// for every request of the same origin (pages, scripts, fetches, the service-worker script).
const user = process.env.REHEARSAL_USER ?? '';
const pass = process.env.REHEARSAL_PASSWORD ?? '';
const wrong = process.env.REHEARSAL_WRONG ?? '';

test.describe('with the right Basic credentials', () => {
  test.use({ httpCredentials: { username: user, password: pass } });

  test('the login page and its scripts load; the app still asks for its own sign-in', async ({ page }) => {
    const bad: string[] = [];
    page.on('response', (r) => {
      if (r.status() === 401) bad.push(r.url());
    });
    const res = await page.goto('/fr/login');
    expect(res?.status()).toBe(200);
    await expect(page.getByText(/formation/i).first()).toBeVisible();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
    // a protected page is not opened by Basic credentials alone
    await page.goto('/fr/admin/field');
    await expect(page).toHaveURL(/\/login/);
    expect(bad, 'no request was refused once the credentials were accepted').toEqual([]);
  });

  test('the field (phone) page loads and its API answers from the app, not from the gate', async ({
    page,
  }) => {
    const res = await page.goto('/fr/driver');
    expect(res?.status()).toBe(200);
    const probe = await page.evaluate(async () => {
      const r = await fetch('/api/field/session', { credentials: 'same-origin' });
      return { status: r.status, challenge: r.headers.get('www-authenticate') };
    });
    expect(probe.challenge, 'the app does not send a Basic challenge').toBeNull();
    expect([401, 403, 404]).toContain(probe.status);
  });

  test('a service worker installs and activates behind the gate (the PWA still works)', async ({ page }) => {
    await page.goto('/fr/login');
    const state = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      return { scope: reg.scope, active: !!reg.active || !!(await navigator.serviceWorker.ready).active };
    });
    expect(state.active).toBe(true);
    // after activation the page still works with the worker in control
    await page.reload();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
    const manifest = await page.evaluate(async () => (await fetch('/app.webmanifest')).status);
    expect(manifest).toBe(200);
  });
});

test.describe('without or with wrong Basic credentials', () => {
  test('no credentials: the browser gets the challenge and nothing of the app', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const res = await page.goto('/fr/login');
    expect(res?.status()).toBe(401);
    expect(res?.headers()['www-authenticate']).toMatch(/^Basic /);
    expect(await page.content()).not.toMatch(/formation|password/i);
    const reg = await page.evaluate(async () => {
      try {
        await navigator.serviceWorker.register('/sw.js');
        return 'registered';
      } catch (e) {
        return String(e).includes('SSL') ? 'tls-error' : 'refused';
      }
    });
    expect(reg).toBe('refused');
    await ctx.close();
  });

  test('wrong credentials stay refused', async ({ browser }) => {
    const ctx = await browser.newContext({ httpCredentials: { username: user, password: wrong } });
    const page = await ctx.newPage();
    const res = await page.goto('/fr/login');
    expect(res?.status()).toBe(401);
    await ctx.close();
  });
});
