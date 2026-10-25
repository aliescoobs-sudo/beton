import { expect, type Page, test } from '@playwright/test';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// ledger L20 + L21 + L23: purchases. The owner enters and reads them, office enters blind, the plant receives the goods
// and sees quantities only; cancelling is the owner's.
test.describe.configure({ mode: 'serial' });

const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
let ownerCode = '';
let officeCode = '';

async function enter(page: Page, invoiceNo: string) {
  await page.goto('/fr/purchases/new');
  await page.getByTestId('purchase-supplier').selectOption({ index: 1 });
  await page.getByTestId('purchase-invoice-no').fill(invoiceNo);
  await page.getByTestId('purchase-line-component').selectOption({ label: 'Ciment' });
  await page.getByTestId('purchase-line-unit').selectOption({ label: 't' });
  await page.getByTestId('purchase-line-qty').fill('30');
  await page.getByTestId('purchase-line-price').fill('1 450,00');
  await page.getByTestId('purchase-add-line').click();
  const second = page.getByTestId('purchase-line').nth(1);
  await second.getByTestId('purchase-line-kind').selectOption('service');
  await second.getByTestId('purchase-line-description').fill('Transport (test)');
  await second.getByTestId('purchase-line-price').fill('2 500,00');
  await page.getByTestId('purchase-save').click();
  const saved = page.getByTestId('purchase-saved');
  await expect(saved).toContainText('ACH-');
  return /ACH-\d{4}-\d{5}/.exec((await saved.textContent()) ?? '')?.[0] as string;
}

test('the owner enters a purchase, sees the payable it creates, reads the list and the detail, and cancels it', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  ownerCode = await enter(page, `FO-${suffix}`);
  // 30 t x 1 450,00 + 2 500,00 = 46 000,00 HT; VAT 20 % 9 200,00; TTC 55 200,00.
  await expect(page.getByTestId('purchase-effects')).toContainText('55 200,00 MAD');

  await goNav(page, 'purchases-link');
  await expect(page).toHaveURL('/fr/purchases');
  const row = page.getByTestId(`purchase-${ownerCode}`);
  await expect(row).toContainText('55 200,00');
  await expect(row).toContainText('En attente de réception');
  await row.getByRole('link', { name: ownerCode }).click();
  await expect(page.getByTestId('purchase-head')).toContainText(`FO-${suffix}`);
  await expect(page.getByTestId('purchase-lines')).toContainText('Transport (test)');
  await expect(page.getByTestId('purchase-plan')).toContainText('55 200,00');

  // The cancel button needs a reason and writes a reversing entry.
  await page.getByTestId('purchase-cancel').click();
  await page.getByTestId('purchase-cancel-reason').fill('Commande doublon (test)');
  await page.getByTestId('purchase-cancel-confirm').click();
  await expect(page.getByTestId('purchase-cancelled')).toBeVisible();
  await logout(page);
});

test('office enters a purchase blind: a code and no amount; it has no list', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.purOffice.email);
  const code = await enter(page, `FB-${suffix}`);
  officeCode = code;
  await expect(page.getByTestId('purchase-effects')).not.toContainText(/MAD|DH|\d,\d{2}/);
  await expect(page.locator('body')).not.toContainText(/MAD|DH/);
  await expect(page.getByTestId('purchases-link')).toHaveCount(0);
  expect((await page.goto('/fr/purchases'))?.status()).toBe(404);
  expect((await page.goto(`/fr/purchases/${code}`))?.status()).toBe(404);
});

test('the plant receives the goods and sees quantities only', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.purPlant.email);
  expect((await page.goto('/fr/purchases'))?.status()).toBe(404);
  await page.goto('/fr/receipts');
  const list = page.getByTestId('receipts-list');
  await expect(list).toContainText('Ciment');
  await expect(page.locator('body')).not.toContainText(/MAD|DH|\d\s?\d{3},\d{2}/);
  await page.getByTestId(`receive-${officeCode}`).click();
  await expect(page.getByTestId(`receipt-effects-${officeCode}`)).toContainText('+30 000 kg');
});
