import { expect, test } from '@playwright/test';
import { E2E_MD, loginAndEnrol, goNav } from './fixtures';

// T800-T899: the pilot seed uses T1-T4, the integration tests T900+.
const code = `T${800 + (Date.now() % 100)}`;
const plate = `E2E-${Date.now().toString(36).toUpperCase()}`.slice(0, 20);

test('a partner adds a truck and the plant then logs a breakdown on it', async ({ page, browser }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.truckPartnerFr.email);
  await goNav(page, 'trucks-link');
  await expect(page).toHaveURL('/fr/master-data/trucks');
  const form = page.getByTestId('truck-new');
  await form.locator('input[name=code]').fill(code);
  await form.locator('input[name=plate]').fill(plate);
  await form.locator('input[name=capacityM3]').fill('8,5');
  await form.locator('button[type=submit]').click();
  const row = page.getByTestId(`truck-${code}`);
  await expect(row).toBeVisible();
  await expect(row.locator('input[name=capacityM3]')).toHaveValue('8,5');

  const plantPage = await (await browser.newContext()).newPage();
  await loginAndEnrol(plantPage, 'fr', E2E_MD.truckPlant.email);
  await goNav(plantPage, 'trucks-link');
  const plantRow = plantPage.getByTestId(`truck-${code}`);
  // The plant reads the truck but cannot edit its plate or capacity.
  await expect(plantRow.getByTestId('truck-plate')).toHaveText(plate);
  await expect(plantRow).toContainText('8,5 m³');
  await expect(plantRow.locator('input[name=plate]')).toHaveCount(0);
  const logForm = plantPage.getByTestId(`truck-log-form-${code}`);
  await expect(plantPage.getByTestId('truck-new')).toHaveCount(0);
  await logForm.locator('select[name=status]').selectOption('breakdown');
  await logForm.locator('input[name=fromDate]').fill('2026-11-04');
  await logForm.locator('input[name=toDate]').fill('2026-11-06');
  await logForm.locator('input[name=reason]').fill('Boîte de vitesses');
  await logForm.locator('button[type=submit]').click();
  await expect(plantPage.getByTestId(`truck-log-${code}`)).toContainText('Panne');
  await expect(plantPage.getByTestId(`truck-log-${code}`)).toContainText('Boîte de vitesses');
});

test('office reads trucks and their log with no edit control', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.truckOffice.email);
  await goNav(page, 'trucks-link');
  await expect(page).toHaveURL('/fr/master-data/trucks');
  await expect(page.locator('button[type=submit]')).toHaveCount(0);
});

test('the trucks screen renders right-to-left in Arabic', async ({ page }) => {
  await loginAndEnrol(page, 'ar', E2E_MD.truckPartnerAr.email);
  await goNav(page, 'trucks-link');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الشاحنات');
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
