import { expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { createLoad, markDelivered } from '../src/modules/operations';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout, moneySafeSuffix, orderStep } from './fixtures';

// operations O6 + ledger L35: one action, its effect end to end. order -> load -> stock down -> invoice -> cheque -> cash,
// and after every step the panel says what it changed. The owner sees the money facts, office sees none.
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));

const suffix = moneySafeSuffix(5);
const bank = `Banque flux ${suffix}`;
const cheque = `FLX${suffix}`;
const mad = (text: string | null) => {
  const t = text ?? '';
  const n = Number(t.replace(/[^\d,]/g, '').replace(',', '.'));
  return /^\s*[−-]/.test(t) ? -n : n;
};

async function newOrder(page: Page, m3: string) {
  await page.goto('/fr/orders/new');
  await page.getByTestId('order-client-search').fill('Atlas');
  await page.getByTestId('order-client').selectOption({ index: 1 });
  await page.getByTestId('order-type').selectOption({ label: 'B25 · Béton B25' });
  await page.getByTestId('order-volume').fill(m3);
  await page.getByTestId('order-method').selectOption('GOULOTTE');
  await orderStep(page, 3);
  await page.getByTestId('order-preset').selectOption('cash');
  await page.getByTestId('order-save').click();
  const saved = page.getByTestId('order-saved');
  await expect(saved).toContainText('CMD-');
  return /CMD-\d{4}-\d{5}/.exec((await saved.textContent()) ?? '')?.[0] as string;
}

async function pay(page: Page, amount: string, number: string, orderCode: string) {
  await page.goto('/fr/payments/new');
  await page.getByTestId('payment-search').fill('Atlas');
  await page.getByTestId('payment-party').selectOption({ index: 1 });
  await page.getByTestId('payment-method').selectOption('cheque');
  await page.getByTestId('payment-amount').fill(amount);
  await page.getByTestId('payment-number').fill(number);
  await page.getByTestId('payment-bank').fill('Banque fictive');
  await page.getByTestId('payment-written').fill('2026-01-02');
  await page.getByTestId('payment-order').fill(orderCode);
  await page.getByTestId('payment-save').click();
  await expect(page.getByTestId('payment-saved')).toBeVisible();
}

test('the owner walks order, load, stock, invoice, cheque and cash, and sees what each step changed', async ({
  page,
}) => {
  await loginOwner(page, 'fr');

  // A bank to deposit into.
  await page.goto('/fr/accounts');
  await page.getByTestId('account-add').click();
  await page.getByTestId('account-kind').selectOption('bank');
  await page.getByTestId('account-new').locator('input[name="label"]').fill(bank);
  await page.getByTestId('account-new').locator('input[name="bankName"]').fill('Banque fictive');
  await page.getByTestId('account-new').getByRole('button', { name: 'Ajouter un compte' }).click();
  await expect(page.getByTestId(`account-${bank}`)).toBeVisible();

  // Where we start: the real cash and the cement in stock.
  await page.goto('/fr/cash');
  const cashBefore = mad(await page.getByTestId('cash-real').textContent());
  await page.goto('/fr/stock');
  const cementRow = page.locator('tr', { hasText: 'Ciment' }).first();
  const cementBefore = mad(await cementRow.locator('td').nth(1).textContent());

  // 1. Order: 4 m³ of B25 at the 820,00 override = 3 280,00 HT, 3 936,00 TTC.
  const orderCode = await newOrder(page, '4');
  const orderEffects = page.getByTestId('order-effects');
  await expect(orderEffects).toContainText(orderCode);
  await expect(orderEffects).toContainText('3 936,00 MAD');

  // 2. Load: the plant's action, here done by the owner; the stock of cement goes down by 4 x 350 kg.
  await goNav(page, 'loads-link');
  await expect(page.getByTestId(`due-${orderCode}`)).toBeVisible();
  await page.getByTestId(`load-create-${orderCode}`).click();
  const loadEffects = page.getByTestId(`load-effects-${orderCode}`);
  await expect(loadEffects).toContainText('Ciment');
  await expect(loadEffects).toContainText('−1 400 kg');
  const blNo = /BL-\d{4}-\d{5}/.exec(
    (await page.getByTestId(`load-done-${orderCode}`).textContent()) ?? '',
  )?.[0] as string;
  await page.getByTestId(`load-continue-${orderCode}`).click();
  // The truck unloaded: the load is delivered, so it can be billed.
  await page.getByTestId(`mark-delivered-${blNo}`).click();
  await expect(page.getByTestId(`delivery-${blNo}`)).toContainText('Livré');

  // 3. The stock screen agrees.
  await goNav(page, 'stock-link');
  const cementAfter = mad(
    await page.locator('tr', { hasText: 'Ciment' }).first().locator('td').nth(1).textContent(),
  );
  expect(cementBefore - cementAfter).toBe(1400);

  // 4. Invoice: the owner sees the receivable it creates.
  await goNav(page, 'invoices-new-link');
  await page.getByTestId('invoice-order-code').fill(orderCode);
  await page.getByTestId('invoice-save').click();
  const invoiceEffects = page.getByTestId('invoice-effects');
  await expect(invoiceEffects).toContainText('3 936,00 MAD');
  const invoiceNumber = /FA-\d{4}-\d{5}/.exec(
    (await page.getByTestId('invoice-saved').textContent()) ?? '',
  )?.[0] as string;
  await goNav(page, 'invoices-link');
  await expect(page.getByTestId(`invoice-${invoiceNumber}`)).toContainText('3 936,00');

  // 5. Cheque for the whole order: received, covering the order.
  await pay(page, '3 936,00', cheque, orderCode);
  const paymentEffects = page.getByTestId('payment-effects');
  await expect(paymentEffects).toContainText('3 936,00 MAD');
  await expect(paymentEffects).toContainText('pas encore encaissé');

  // 6. Deposit, clear: the real cash goes up by the cheque.
  await goNav(page, 'instruments-link');
  await page.getByTestId(`batch-pick-${cheque}`).check();
  await page.getByTestId('batch-account').selectOption({ label: bank });
  await page.getByTestId('batch-deposit').click();
  const row = page.getByTestId(`actions-${cheque}`);
  await row.getByTestId('action-clear').click();
  await row.getByTestId('clear-account').selectOption({ label: bank });
  await row.getByTestId('action-confirm').click();
  await expect(page.getByTestId(`instrument-${cheque}`).getByTestId('instrument-state')).toContainText(
    'Encaissé',
  );
  await goNav(page, 'cash-link');
  expect(mad(await page.getByTestId('cash-real').textContent()) - cashBefore).toBeCloseTo(3936, 2);
  await logout(page);
});

test('office walks order, invoice and cheque: it sees the documents and the stock, no amount, no balance', async ({
  page,
}) => {
  const plant = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'plant');
  await loginAndEnrol(page, 'fr', E2E_MD.flowOffice.email);
  const orderCode = await newOrder(page, '3');
  const orderEffects = page.getByTestId('order-effects');
  await expect(orderEffects).toContainText(orderCode);
  await expect(orderEffects).toContainText('Livraison prévue');
  await expect(orderEffects).not.toContainText(/MAD|DH|\d,\d{2}/);

  // The plant loads it (the load is not office's job).
  const row = (
    await migrator.query<{ id: string; truck: string }>(
      `select o.id, (select id from truck where code = 'T1') as truck from sales_order o where o.code = $1`,
      [orderCode],
    )
  ).rows[0];
  const load = await createLoad(
    app,
    plant,
    { orderId: row?.id, truckId: row?.truck, volumeL: 3000 },
    { today: new Date().toISOString().slice(0, 10) },
  );
  expect(load.ok).toBe(true);
  // The truck unloaded (the plant's tracking): only a delivered load is billed.
  if (load.ok) await markDelivered(app, plant, { deliveryId: load.value.id }, { now: new Date() });

  await goNav(page, 'invoices-new-link');
  await page.getByTestId('invoice-order-code').fill(orderCode);
  await page.getByTestId('invoice-save').click();
  await expect(page.getByTestId('invoice-saved')).toContainText('FA-');
  await expect(page.getByTestId('invoice-effects')).toContainText('Facture');
  await expect(page.getByTestId('invoice-effects')).not.toContainText(/MAD|DH|\d,\d{2}/);

  await pay(page, '2 952,00', `${cheque}O`, orderCode);
  const paymentEffects = page.getByTestId('payment-effects');
  await expect(paymentEffects).toContainText('Paiement enregistré');
  await expect(paymentEffects).not.toContainText(/MAD|DH|\d,\d{2}/);
  await expect(page.locator('body')).not.toContainText(/MAD|DH/);
  // No invoices list, no stock, no cash for office.
  await expect(page.getByTestId('invoices-link')).toHaveCount(0);
  expect((await page.goto('/fr/invoices'))?.status()).toBe(404);
  expect((await page.goto('/fr/stock'))?.status()).toBe(404);
});
