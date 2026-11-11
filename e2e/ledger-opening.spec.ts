import { expect, test } from '@playwright/test';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// ledger L33: the opening state. The owner enters the date once and what a client owes; the accountant reads; office has no page.
test.describe.configure({ mode: 'serial' });

test('the owner enters the opening date once and a client balance', async ({ page }) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'opening-link');
  await expect(page).toHaveURL('/fr/opening');
  if (await page.getByTestId('opening-date-form').isVisible()) {
    await page.getByTestId('opening-date-input').fill('2026-01-01');
    await page.getByTestId('opening-date-save').click();
  }
  await expect(page.getByTestId('opening-date')).toContainText('2026-01-01');
  // The date can no longer be entered again.
  await expect(page.getByTestId('opening-date-form')).toHaveCount(0);

  await page.getByTestId('opening-party').selectOption({ index: 1 });
  await page.getByTestId('opening-amount').fill('12 500,00');
  await page.getByTestId('opening-party-save').click();
  await expect(page.locator('[data-testid^="opening-row-"]').first()).toContainText('12 500,00');
  await logout(page);
});

test('office has no link and no page', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.openOffice.email);
  await expect(page.getByTestId('opening-link')).toHaveCount(0);
  expect((await page.goto('/fr/opening'))?.status()).toBe(404);
});

test('Arabic renders right-to-left with the amount left-to-right', async ({ page }) => {
  await loginOwner(page, 'ar');
  await page.goto('/ar/opening');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(
    page.locator('[data-testid^="opening-row-"]').first().locator('bdi[dir="ltr"]').first(),
  ).toBeVisible();
});
