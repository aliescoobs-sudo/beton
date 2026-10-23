import { expect, test } from '@playwright/test';
import { E2E_MD, loginAndEnrol, goNav } from './fixtures';

test.describe.configure({ mode: 'serial' });

// Versions only move forward: each run picks a date later than any previous run's (one day per 10 s).
const date = new Date(Date.UTC(2200, 0, 1) + Math.floor((Date.now() - 1.78e12) / 10_000) * 86_400_000)
  .toISOString()
  .slice(0, 10);

test('a partner publishes a list price for B25 in French; the same date is refused', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.sellPartnerFr.email);
  await goNav(page, 'selling-prices-link');
  await expect(page).toHaveURL('/fr/master-data/selling-prices');
  const form = page.getByTestId('sell-new-B25');
  await form.locator('input[name=price]').fill('950,00');
  await form.locator('input[name=effectiveFrom]').fill(date);
  await form.locator('button[type=submit]').click();
  await expect(page.getByTestId('sell-B25')).toContainText('950,00 MAD HT / m³');
  await expect(page.getByTestId('sell-B25')).toContainText(date);
  await form.locator('input[name=price]').fill('960');
  await form.locator('input[name=effectiveFrom]').fill(date);
  await form.locator('button[type=submit]').click();
  await expect(form.getByTestId('sell-message')).toHaveText(
    'La date doit être postérieure à celle du dernier prix.',
  );
});

test('office reads the list prices without a form; the plant has no access', async ({ page, browser }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.sellOffice.email);
  await goNav(page, 'selling-prices-link');
  await expect(page.getByTestId('sell-B25')).toContainText('MAD HT / m³');
  await expect(page.locator('button[type=submit]')).toHaveCount(0);

  const plant = await browser.newPage();
  await loginAndEnrol(plant, 'fr', E2E_MD.sellPlant.email);
  const response = await plant.goto('/fr/master-data/selling-prices');
  expect(response?.status()).toBe(404);
  await plant.close();
});

test('the selling prices screen renders right-to-left in Arabic', async ({ page }) => {
  await loginAndEnrol(page, 'ar', E2E_MD.sellPartnerAr.email);
  await goNav(page, 'selling-prices-link');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('أسعار البيع (القائمة)');
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
