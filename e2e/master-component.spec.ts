import { expect, test } from '@playwright/test';
import { E2E_MD, loginAndEnrol, goNav } from './fixtures';

test.describe.configure({ mode: 'serial' });

test('an app_admin adds a component with both names and a purchase unit in French', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.componentAdminFr.email);
  await goNav(page, 'components-link');
  await expect(page).toHaveURL('/fr/master-data/components');
  await expect(page.getByTestId('component-CMP-01')).toContainText('Ciment');

  const name = `Fibre ${Date.now()}`;
  await page.getByTestId('component-add').click();
  const form = page.getByTestId('component-new');
  await form.locator('input[name=nameFr]').fill(name);
  await form.locator('input[name=nameAr]').fill('ألياف');
  await form.locator('button[type=submit]').click();
  const row = page.locator('tbody', { hasText: name }).first();
  await expect(row).toBeVisible();

  await row.locator('[data-testid^=unit-add-]').click();

  const unit = row.locator('form[data-testid^=unit-new]');
  await unit.locator('input[name=label]').fill('sac 25 kg');
  await unit.locator('input[name=factorToBase]').fill('25000');
  await unit.locator('button[type=submit]').click();
  await expect(row.getByTestId('unit-sac 25 kg')).toContainText('25000');
});

test('plant reads components with no edit control', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.componentPlant.email);
  await goNav(page, 'components-link');
  await expect(page.getByTestId('component-CMP-01')).toContainText('Ciment');
  await expect(page.locator('button[type=submit]')).toHaveCount(0);
});

test('the components screen renders right-to-left in Arabic with Arabic names', async ({ page }) => {
  await loginAndEnrol(page, 'ar', E2E_MD.componentAdminAr.email);
  await goNav(page, 'components-link');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('component-CMP-01').getByTestId('component-name')).toHaveText('إسمنت');
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
