import { expect, test } from '@playwright/test';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';
import { checkScreen, watch } from './screen-check';

// operations O13 (AC-OPS-22): the plant records fills and reads litres, km and litres per m³ with no money; the owner records
// the fuel bought and sees the price and the cost per m³; the partner reads the quantities only.
test.describe.configure({ mode: 'serial' });

const MONEY = /MAD|DH|\d\s?\d{3},\d{2}/;
let truckCode = '';

test('the plant records two fills of a truck with the odometer and sees no money', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.fuelPlant.email);
  await goNav(page, 'fuel-link');
  await expect(page).toHaveURL('/fr/fuel');
  const option = page.getByTestId('fuel-truck').locator('option').first();
  truckCode = ((await option.textContent()) ?? '').trim();
  expect(truckCode).toMatch(/^T\d+$/);
  for (const [litres, km] of [
    ['180', '300000'],
    ['210,5', '300600'],
  ] as const) {
    await page.getByTestId('fuel-litres').fill(litres);
    await page.getByTestId('fuel-odometer').fill(km);
    await page.getByTestId('fuel-fill-submit').click();
    await expect(page.getByTestId('fuel-fill-message')).toContainText('Plein enregistré');
  }
  const row = page.getByTestId(`fuel-${truckCode}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('600');
  await expect(page.getByTestId('fuel-recent')).toContainText(truckCode);
  // a reading lower than an earlier one is refused
  await page.getByTestId('fuel-litres').fill('50');
  await page.getByTestId('fuel-odometer').fill('1000');
  await page.getByTestId('fuel-fill-submit').click();
  await expect(page.getByTestId('fuel-fill-message')).toContainText('compteur');
  await expect(page.getByTestId('fuel-purchase-form')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(MONEY);
  await expect(page.locator('th', { hasText: 'Coût' })).toHaveCount(0);
  await logout(page);
});

test('the owner records the fuel bought and sees the average price and the cost columns', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await page.goto('/fr/fuel');
  await page.getByTestId('fuel-purchase-litres').fill('1000');
  await page.getByTestId('fuel-purchase-total').fill('12000');
  await page.getByTestId('fuel-purchase-submit').click();
  await expect(page.getByTestId('fuel-purchase-message')).toContainText('Achat enregistré');
  await expect(page.getByTestId('fuel-price')).toContainText('MAD');
  await expect(page.locator('th', { hasText: 'Coût par m³' })).toBeVisible();
  await expect(page.getByTestId(`fuel-${truckCode}`)).toContainText('MAD');
});

test('the partner reads the quantities and no money; Arabic renders right-to-left', async ({
  page,
  browser,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.fuelPartner.email);
  await page.goto('/fr/fuel');
  await expect(page.getByTestId('fuel-table')).toBeVisible();
  await expect(page.getByTestId('fuel-purchase-form')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(MONEY);

  const ar = await browser.newPage();
  const problems = watch(ar);
  await loginOwner(ar, 'ar');
  await ar.goto('/ar/fuel');
  await expect(ar.getByTestId('fuel-table')).toBeVisible();
  await checkScreen(ar, 'ar', 'fuel');
  expect(problems).toEqual([]);
  await ar.close();
});
