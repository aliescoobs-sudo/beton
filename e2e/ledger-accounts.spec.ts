import { expect, test } from '@playwright/test';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// ledger L8: caisse and bank accounts. Owner writes; support reads; office and partner have neither the link nor the page.
test.describe.configure({ mode: 'serial' });

const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();

test('the owner adds a caisse and a bank account and sets their opening balances', async ({ page }) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'accounts-link');
  await expect(page).toHaveURL('/fr/accounts');

  await page.getByTestId('account-add').click();
  await page.getByTestId('account-new').locator('input[name="label"]').fill(`Caisse ${suffix}`);
  await page.getByTestId('account-new').getByRole('button', { name: 'Ajouter un compte' }).click();
  await expect(page.getByTestId('account-message').first()).toContainText('Enregistré');

  await page.getByTestId('account-add').click();
  await page.getByTestId('account-kind').selectOption('bank');
  await page.getByTestId('account-new').locator('input[name="label"]').fill(`Banque ${suffix}`);
  await page.getByTestId('account-new').locator('input[name="bankName"]').fill('Banque fictive');
  await page.getByTestId('account-new').getByRole('button', { name: 'Ajouter un compte' }).click();
  await expect(page.getByTestId(`account-Banque ${suffix}`)).toBeVisible();

  const caisse = page.getByTestId(`account-Caisse ${suffix}`);
  await caisse.getByTestId('account-set-opening').click();
  await caisse.locator('input[name="asOf"]').fill('2026-01-01');
  await caisse.getByTestId('account-amount').fill('2 500,00');
  await caisse.getByTestId('account-opening-save').click();
  await expect(caisse.getByTestId('account-opening')).toContainText('2 500,00');
  await expect(caisse.getByTestId('account-set-opening')).toHaveCount(0);

  // A debit balance is typed with a minus sign.
  const bank = page.getByTestId(`account-Banque ${suffix}`);
  await bank.getByTestId('account-set-opening').click();
  await bank.locator('input[name="asOf"]').fill('2026-01-01');
  await bank.getByTestId('account-amount').fill('-12000');
  await bank.getByTestId('account-opening-save').click();
  await expect(bank.getByTestId('account-opening')).toContainText('-12 000,00');
  await logout(page);
});

test('support reads the accounts without any form; office and partner have no link and no page', async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.acctSupport.email);
  await goNav(page, 'accounts-link');
  await expect(page.getByTestId(`account-Caisse ${suffix}`)).toContainText('2 500,00');
  await expect(page.getByTestId('account-add')).toHaveCount(0);
  await expect(page.getByTestId('account-set-opening')).toHaveCount(0);
  await logout(page);

  for (const user of [E2E_MD.acctOffice, E2E_MD.acctPartner]) {
    await loginAndEnrol(page, 'fr', user.email);
    await expect(page.getByTestId('accounts-link')).toHaveCount(0);
    const response = await page.goto('/fr/accounts');
    expect(response?.status()).toBe(404);
    await page.goto('/fr');
    await logout(page);
  }
});

test('the screen renders right-to-left in Arabic', async ({ page }) => {
  await loginOwner(page, 'ar');
  await page.goto('/ar/accounts');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId(`account-Caisse ${suffix}`)).toBeVisible();
  await expect(page.getByTestId(`account-Caisse ${suffix}`).getByTestId('account-opening')).toContainText(
    '2 500,00',
  );
});
