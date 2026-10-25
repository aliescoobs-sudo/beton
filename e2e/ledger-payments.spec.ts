import { expect, test } from '@playwright/test';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { testEnv } from '../tests/db-env';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// ledger L14: receive and list payments. Office enters blind (no amount echoed, no list); owner and support list them.
test.describe.configure({ mode: 'serial' });

const migrator = new pg.Pool({ connectionString: testEnv(E2E_DATABASE).DATABASE_URL_MIGRATOR, max: 1 });
test.afterAll(() => migrator.end());
const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
const chequeNo = `E2E${suffix}`;

test('the owner makes sure there is a caisse', async ({ page }) => {
  await loginOwner(page, 'fr');
  await page.goto('/fr/accounts');
  await page.getByTestId('account-add').click();
  await page.getByTestId('account-new').locator('input[name="label"]').fill(`Caisse paiements ${suffix}`);
  await page.getByTestId('account-new').getByRole('button', { name: 'Ajouter un compte' }).click();
  await expect(page.getByTestId(`account-Caisse paiements ${suffix}`)).toBeVisible();
  await logout(page);
});

test('office enters a cash payment and a post-dated cheque for an order, blind', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.payOffice.email);
  await goNav(page, 'payments-new-link');
  await expect(page).toHaveURL('/fr/payments/new');
  await expect(page.getByTestId('instruments-link')).toHaveCount(0);

  await page.getByTestId('payment-search').fill('Atlas');
  await page.getByTestId('payment-party').selectOption({ index: 1 });
  await page.getByTestId('payment-method').selectOption('cash');
  await page.getByTestId('payment-amount').fill('1 250,00');
  await page.getByTestId('payment-save').click();
  await expect(page.getByTestId('payment-saved')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/1 250|MAD|DH/);

  // A cheque against the latest Atlas order, written far in the future.
  const order = (
    await migrator.query<{ code: string }>(
      `select o.code from sales_order o join client c on c.id = o.client_id where c.name ilike '%atlas%' and o.reverses_id is null
          and not exists (select 1 from sales_order r where r.reverses_id = o.id)
          and (select coalesce(sum(a.amount_centimes), 0) from allocation a join payment_plan_item i on i.id = a.payment_plan_item_id where i.order_id = o.id) < o.total_ttc_centimes - 200000
        order by o.created_at desc limit 1`,
    )
  ).rows[0];
  expect(order?.code).toMatch(/^CMD-/);
  await page.getByTestId('payment-another').click();
  await page.getByTestId('payment-search').fill('Atlas');
  await page.getByTestId('payment-party').selectOption({ index: 1 });
  await page.getByTestId('payment-method').selectOption('cheque');
  await page.getByTestId('payment-amount').fill('2 000,00');
  await page.getByTestId('payment-number').fill(chequeNo);
  await page.getByTestId('payment-bank').fill('Banque fictive');
  await page.getByTestId('payment-written').fill('2099-01-01');
  await page.getByTestId('payment-order').fill(order?.code ?? '');
  await page.getByTestId('payment-save').click();
  await expect(page.getByTestId('payment-saved')).toBeVisible();
  const covered = await migrator.query<{ s: string }>(
    `select coalesce(sum(a.amount_centimes), 0)::text as s from allocation a join payment_instrument i on i.id = a.instrument_id where i.number = $1`,
    [chequeNo],
  );
  expect(covered.rows[0]?.s).toBe('200000');

  // A code that fits nothing is refused with a plain message, and nothing is saved.
  await page.getByTestId('payment-another').click();
  await page.getByTestId('payment-search').fill('Atlas');
  await page.getByTestId('payment-party').selectOption({ index: 1 });
  await page.getByTestId('payment-method').selectOption('transfer');
  await page.getByTestId('payment-amount').fill('10,00');
  await page.getByTestId('payment-order').fill('CMD-1999-99999');
  await page.getByTestId('payment-save').click();
  await expect(page.getByTestId('payment-error')).toBeVisible();

  // No list for office.
  const response = await page.goto('/fr/instruments');
  expect(response?.status()).toBe(404);
});

test('the owner and support list the payments with their state and badges', async ({ page }) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'instruments-link');
  await expect(page).toHaveURL('/fr/instruments');
  const row = page.getByTestId(`instrument-${chequeNo}`);
  await expect(row).toContainText('2 000,00');
  await expect(row.getByTestId('instrument-state')).toContainText('Reçu');
  await expect(row.getByTestId('instrument-postdated')).toBeVisible();
  await logout(page);

  await loginAndEnrol(page, 'fr', E2E_MD.paySupport.email);
  await goNav(page, 'instruments-link');
  await expect(page.getByTestId(`instrument-${chequeNo}`)).toBeVisible();
  await logout(page);

  await loginAndEnrol(page, 'fr', E2E_MD.payPlant.email);
  await expect(page.getByTestId('payments-new-link')).toHaveCount(0);
  expect((await page.goto('/fr/payments/new'))?.status()).toBe(404);
  expect((await page.goto('/fr/instruments'))?.status()).toBe(404);
});

test('Arabic: the form and the list render right-to-left, numbers left-to-right', async ({ page }) => {
  await loginAndEnrol(page, 'ar', E2E_MD.payOfficeAr.email);
  await page.goto('/ar/payments/new');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('payment-amount')).toHaveAttribute('dir', 'ltr');
  await logout(page);
  await loginOwner(page, 'ar');
  await page.goto('/ar/instruments');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId(`instrument-${chequeNo}`).locator('bdi[dir="ltr"]').first()).toBeVisible();
});
