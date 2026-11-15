import { expect, test } from '@playwright/test';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// ledger L6 + L7 (+ the cancel button of L5): the owner's orders list and detail, a price override with its reason, the
// state of each échéance, the cancellation. Office has neither the link nor the page.
test.describe.configure({ mode: 'serial' });

test('the owner enters an order at another price, reads it in the list and the detail, and cancels it', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await page.goto('/fr/orders/new');
  await page.getByTestId('order-client-search').fill('Atlas');
  await page.getByTestId('order-client').selectOption({ index: 1 });
  await page.getByTestId('order-type').selectOption({ label: 'B25 · Béton B25' });
  await page.getByTestId('order-volume').fill('5');
  await page.getByTestId('order-method').selectOption('GOULOTTE');
  await page.getByTestId('order-preset').selectOption('advance50');
  // A reason is mandatory with a price.
  await page.getByTestId('order-override-price').fill('700,00');
  await page.getByTestId('order-save').click();
  await expect(page.getByTestId('order-message')).toBeVisible();
  await page.getByTestId('order-override-reason').fill('Remise exceptionnelle (test)');
  await page.getByTestId('order-save').click();
  const saved = page.getByTestId('order-saved');
  await expect(saved).toContainText('CMD-');
  const code = /CMD-\d{4}-\d{5}/.exec((await saved.textContent()) ?? '')?.[0] as string;
  // 5 m³ x 700,00 = 3 500,00 HT, 4 200,00 TTC.
  await expect(page.getByTestId('order-effects')).toContainText('4 200,00 MAD');

  await goNav(page, 'orders-link');
  await expect(page).toHaveURL('/fr/orders');
  const row = page.getByTestId(`order-${code}`);
  await expect(row).toContainText('4 200,00');
  await row.getByRole('link', { name: code }).click();
  await expect(page.getByTestId('order-head')).toContainText('700,00');
  await expect(page.getByTestId('order-head')).toContainText('Remise exceptionnelle (test)');
  // The 50 % advance is due on the order date: today, not yet covered; the delivery half is due today too.
  await expect(page.getByTestId('plan-item-1')).toContainText('2 100,00');
  await expect(page.getByTestId('plan-item-1')).toHaveAttribute('data-state', /pending|overdue/);

  await page.getByTestId('order-cancel').click();
  await page.getByTestId('order-cancel-reason').fill('Chantier reporté (test)');
  await page.getByTestId('order-cancel-confirm').click();
  await expect(page.getByTestId('order-cancelled')).toBeVisible();
  await expect(page.getByTestId('plan-item-1')).toHaveAttribute('data-state', 'cancelled');
  await logout(page);
});

test('office has no orders list: no link, a 404', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.viewOffice.email);
  await expect(page.getByTestId('orders-link')).toHaveCount(0);
  expect((await page.goto('/fr/orders'))?.status()).toBe(404);
  await expect(page.getByTestId('order-override')).toHaveCount(0);
  await page.goto('/fr/orders/new');
  await expect(page.getByTestId('order-override')).toHaveCount(0);
});
