import { expect, test } from '@playwright/test';
import { E2E_MD, loginAndEnrol, goNav } from './fixtures';

test('a partner reads the seeded types and adds one in French', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.typePartnerFr.email);
  await goNav(page, 'concrete-types-link');
  await expect(page).toHaveURL('/fr/master-data/concrete-types');
  await expect(page.getByTestId('type-B25')).toBeVisible();
  const code = `E${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  await page.getByTestId('type-add').click();
  const form = page.getByTestId('type-new');
  await form.locator('input[name=code]').fill(code);
  await form.locator('input[name=label]').fill('Béton E2E');
  await form.locator('button[type=submit]').click();
  await expect(page.getByTestId(`type-${code}`)).toBeVisible();
});

test('plant reads the types with no edit control', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.typePlant.email);
  await goNav(page, 'concrete-types-link');
  await expect(page.getByTestId('type-B20')).toBeVisible();
  await expect(page.locator('button[type=submit]')).toHaveCount(0);
});

test('the types screen renders right-to-left in Arabic', async ({ page }) => {
  await loginAndEnrol(page, 'ar', E2E_MD.typePartnerAr.email);
  await goNav(page, 'concrete-types-link');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('أنواع الخرسانة');
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
