import { expect, test } from '@playwright/test';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// ledger L16: encaissé vs total. Owner and accountant read; office has neither the link nor the page (AC-SEC-05).
test.describe.configure({ mode: 'serial' });

const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();

test('the owner sees real cash and the total, with a new account at its opening balance', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await page.goto('/fr/accounts');
  await page.getByTestId('account-add').click();
  await page.getByTestId('account-kind').selectOption('bank');
  await page.getByTestId('account-new').locator('input[name="label"]').fill(`Trésor ${suffix}`);
  await page.getByTestId('account-new').locator('input[name="bankName"]').fill('Banque fictive');
  await page.getByTestId('account-new').getByRole('button', { name: 'Ajouter un compte' }).click();
  const row = page.getByTestId(`account-Trésor ${suffix}`);
  await row.getByTestId('account-set-opening').click();
  await row.locator('input[name="asOf"]').fill('2026-01-01');
  await row.getByTestId('account-amount').fill('1 000,00');
  await row.getByTestId('account-opening-save').click();
  await expect(row.getByTestId('account-opening')).toContainText('1 000,00');

  await goNav(page, 'cash-link');
  await expect(page).toHaveURL('/fr/cash');
  await expect(page.getByTestId('cash-real')).toContainText('MAD');
  await expect(page.getByTestId('cash-total')).toContainText('MAD');
  await expect(page.getByTestId('cash-incoming')).toBeVisible();
  await expect(page.getByTestId('cash-outgoing')).toBeVisible();
  await expect(
    page.getByTestId(`cash-account-Trésor ${suffix}`).getByTestId('cash-account-real'),
  ).toContainText('1 000,00');
  await logout(page);
});

test('office has no link and no page', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.cashOffice.email);
  await expect(page.getByTestId('cash-link')).toHaveCount(0);
  const response = await page.goto('/fr/cash');
  expect(response?.status()).toBe(404);
});

test('renders right-to-left in Arabic with amounts left-to-right', async ({ page }) => {
  await loginOwner(page, 'ar');
  await page.goto('/ar/cash');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('cash-real').locator('bdi')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByTestId(`cash-account-Trésor ${suffix}`)).toBeVisible();
});
