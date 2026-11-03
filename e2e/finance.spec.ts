import { expect, test } from '@playwright/test';
import { E2E_BASE_URL, E2E_MD, loginOwner, loginAndEnrol, logout } from './fixtures';
test.describe.configure({ mode: 'serial' });
const reference = 'salary-' + Math.random().toString(36).slice(2, 10);
const configure = (page: import('@playwright/test').Page, enabled: boolean) =>
  page.request.post('/api/finance-configuration', {
    headers: { origin: E2E_BASE_URL },
    data: { action: 'configure', enabled, leasingTreatment: 'expense' },
  });
test('owner enables finance, records a fixed expense and downloads a real Excel export', async ({ page }) => {
  await loginOwner(page, 'fr');
  expect((await page.goto('/fr/finance'))?.status()).toBe(404);
  expect((await configure(page, true)).status()).toBe(200);
  await page.goto('/fr/finance');
  await expect(page.getByTestId('finance-report')).toBeVisible();
  await expect(page.getByTestId('finance-link')).toBeVisible();
  await page.getByTestId('finance-tab-entries').click();
  const form = page.getByTestId('finance-entry');
  await form.locator('..').locator('summary').click();
  await form.locator('input[name=amount]').fill('100,00');
  await form.locator('input[name=reference]').fill(reference);
  await form.getByRole('button', { name: 'Confirmer l’enregistrement' }).click();
  await expect(form.locator('..').getByRole('status')).toHaveText('Enregistré.');
  await page.getByTestId('finance-tab-report').click();
  await expect(page.getByTestId('finance-report')).toContainText('100,00 MAD');
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('finance-report').getByRole('link', { name: 'Excel comptable' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  expect(await download.failure()).toBeNull();
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: '.logs/finance-fr-phone.png', fullPage: true });
  await logout(page);
});
test('support has no management page, export, navigation or write endpoint', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.cashSupport.email);
  await expect(page.getByTestId('finance-link')).toHaveCount(0);
  expect((await page.goto('/fr/finance'))?.status()).toBe(404);
  expect((await page.request.get('/fr/finance/export?from=2026-01-01&to=2026-12-31')).status()).toBe(404);
  expect((await configure(page, true)).status()).toBe(404);
  expect(
    (
      await page.request.post('/api/finance', {
        headers: { origin: E2E_BASE_URL },
        data: { action: 'entry' },
      })
    ).status(),
  ).toBe(404);
  await page.goto('/fr');
  await logout(page);
});
test('Arabic phone layout and module-off behavior', async ({ page }) => {
  await loginOwner(page, 'ar');
  await page.goto('/ar/finance');
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('التسيير المالي');
  await expect(page.getByTestId('finance-report').locator('bdi').first()).toHaveAttribute('dir', 'ltr');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: '.logs/finance-ar-phone.png', fullPage: true });
  expect((await configure(page, false)).status()).toBe(200);
  expect((await page.goto('/ar/finance'))?.status()).toBe(404);
  await expect(page.getByTestId('finance-link')).toHaveCount(0);
  expect(
    (
      await page.request.post('/api/finance', {
        headers: { origin: E2E_BASE_URL },
        data: { action: 'entry' },
      })
    ).status(),
  ).toBe(404);
});
