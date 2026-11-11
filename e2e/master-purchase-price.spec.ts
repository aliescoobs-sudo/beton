import { expect, test } from '@playwright/test';
import { E2E_MD, loginAndEnrol, loginOwner, goNav } from './fixtures';

test.describe.configure({ mode: 'serial' });

// Versions only move forward: each run picks a date later than any previous run's (one day per 10 s).
const date = new Date(Date.UTC(2200, 0, 1) + Math.floor((Date.now() - 1.78e12) / 10_000) * 86_400_000)
  .toISOString()
  .slice(0, 10);
const supplier = `Ciments E2E ${Date.now()}`;

test('the owner publishes a purchase price for cement in French, and the cost per m³ appears', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'suppliers-link');
  await page.getByTestId('supplier-add').click();
  const supplierForm = page.getByTestId('supplier-new');
  await supplierForm.locator('input[name=name]').fill(supplier);
  await supplierForm.locator('button[type=submit]').click();
  await expect(page.getByTestId('supplier-message')).toHaveText('Enregistré.');

  await page.goto('/fr');
  await goNav(page, 'purchase-prices-link');
  await expect(page).toHaveURL('/fr/master-data/purchase-prices');
  const form = page.getByTestId('price-new-Ciment');
  await form.locator('select[name=supplierId]').selectOption({ label: supplier });
  await form.locator('input[name=price]').fill('1450,00');
  await form.locator('input[name=effectiveFrom]').fill(date);
  await form.locator('button[type=submit]').click();
  await expect(page.getByTestId('price-Ciment')).toContainText('1 450,00 MAD HT');
  await expect(page.getByTestId('price-Ciment')).toContainText(date);
  // Same date again: refused.
  await form.locator('input[name=price]').fill('1500');
  await form.locator('input[name=effectiveFrom]').fill(date);
  await form.locator('button[type=submit]').click();
  await expect(form.getByTestId('price-message')).toHaveText(
    'La date doit être postérieure à celle du dernier prix.',
  );
  // The stub proposal fills the form with the last price.
  await form.getByRole('button', { name: 'Proposer depuis le dernier achat' }).click();
  await expect(page.getByTestId('price-new-Ciment').locator('input[name=price]')).toHaveValue('1 450,00');
  await expect(page.getByTestId('cost-per-m3')).toBeVisible();
});

test('office and plant have no access (DECISIONS 81)', async ({ browser }) => {
  for (const user of [E2E_MD.priceOffice, E2E_MD.pricePlant]) {
    const other = await browser.newPage();
    await loginAndEnrol(other, 'fr', user.email);
    await expect(other.getByTestId('purchase-prices-link')).toHaveCount(0);
    const response = await other.goto('/fr/master-data/purchase-prices');
    expect(response?.status(), user.email).toBe(404);
    await other.close();
  }
});

test('the purchase prices screen renders right-to-left in Arabic', async ({ page }) => {
  await loginOwner(page, 'ar');
  await goNav(page, 'purchase-prices-link');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('أسعار الشراء');
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
