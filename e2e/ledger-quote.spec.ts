import { expect, test } from '@playwright/test';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// ledger L31 (AC-LED-23): a quote is priced at the price in force, has no ledger effect, and becomes an order only when a human
// saves the prefilled order form. Office enters quotes blind.
test.describe.configure({ mode: 'serial' });

test('the owner makes a quote, reads it, converts it into an order that a human saves', async ({ page }) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'quotes-new-link');
  await page.getByTestId('quote-client-search').fill('Atlas');
  await page.getByTestId('quote-client').selectOption({ index: 1 });
  await page.getByTestId('quote-type').selectOption({ label: 'B25 · Béton B25' });
  await page.getByTestId('quote-volume').fill('5');
  await page.getByTestId('quote-save').click();
  const code = /DV-\d{4}-\d{5}/.exec(
    (await page.getByTestId('quote-saved').textContent()) ?? '',
  )?.[0] as string;
  await expect(page.getByTestId('quote-effects')).toContainText(code);

  await goNav(page, 'quotes-link');
  const row = page.getByTestId(`quote-${code}`);
  // Atlas's override: 5 m³ x 820,00 = 4 100,00 HT, 4 920,00 TTC.
  await expect(row).toContainText('4 920,00');
  await expect(row).toContainText('En cours');
  await row.getByRole('link', { name: code }).click();
  await expect(page.getByTestId('quote-ttc')).toContainText('4 920,00');

  // Convert: the order form comes prefilled; nothing is saved until the person saves it.
  await page.getByTestId('quote-convert').click();
  await expect(page).toHaveURL(/\/fr\/orders\/new\?quote=/);
  await expect(page.getByTestId('order-volume')).toHaveValue('5');
  await page.getByTestId('order-preset').selectOption('cash');
  await page.getByTestId('order-save').click();
  const order = /CMD-\d{4}-\d{5}/.exec(
    (await page.getByTestId('order-saved').textContent()) ?? '',
  )?.[0] as string;
  await page.goto('/fr/quotes');
  await expect(page.getByTestId(`quote-${code}`)).toContainText(order);
  await page.getByTestId(`quote-${code}`).getByRole('link', { name: code }).click();
  await expect(page.getByTestId('quote-converted')).toContainText(order);
  await expect(page.getByTestId('quote-convert')).toHaveCount(0);
  await logout(page);
});

test('office enters a quote blind: a code and no amount; it has no list', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.quoteOffice.email);
  await goNav(page, 'quotes-new-link');
  await page.getByTestId('quote-client-search').fill('Atlas');
  await page.getByTestId('quote-client').selectOption({ index: 1 });
  await page.getByTestId('quote-type').selectOption({ label: 'B25 · Béton B25' });
  await page.getByTestId('quote-volume').fill('3,5');
  await page.getByTestId('quote-save').click();
  await expect(page.getByTestId('quote-saved')).toContainText('DV-');
  await expect(page.locator('body')).not.toContainText(/MAD|DH|\d,\d{2}/);
  await expect(page.getByTestId('quotes-link')).toHaveCount(0);
  expect((await page.goto('/fr/quotes'))?.status()).toBe(404);
});
