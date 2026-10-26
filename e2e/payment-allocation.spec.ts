import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { createInvoice } from '../src/modules/ledger';
import { receiveInstrument } from '../src/modules/ledger';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { clientWithLoads, deliveryScene, orderMaster } from '../tests/helpers/ledger-fixtures';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// integration I1.5: office enters a payment with no order named and it is spread over the client's open invoices, oldest due
// date first; the owner directs another payment to a given invoice, with a reason (AC-INT-09, 10).
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));
const MONEY = /MAD|DH|\d\s?\d{3},\d{2}/;
let clientName = '';
let invoiceA = '';
let invoiceB = '';
const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();

test.beforeAll(async () => {
  const ownerId = (await migrator.query<{ id: string }>(`select id from "user" where role = 'owner'`)).rows[0]
    ?.id as string;
  const marker = `e2eal${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const scene = await deliveryScene(app, ownerId, marker);
  const master = await orderMaster(app, ownerId, marker);
  const c = await clientWithLoads(app, ownerId, master, scene, [[4000], [3000]]);
  clientName = (await migrator.query<{ name: string }>(`select name from client where id = $1`, [c.clientId]))
    .rows[0]?.name as string;
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  // A (3 744,00 TTC) is due later than B (2 808,00 TTC), although it is made first.
  for (const [i, due] of [
    [0, '2099-08-20'],
    [1, '2099-08-05'],
  ] as const) {
    const made = await createInvoice(
      app,
      owner,
      { deliveryIds: c.orders[i]?.deliveryIds, dueDate: due },
      { today: '2099-07-03' },
    );
    if (!made.ok) throw new Error(made.error);
    if (i === 0) invoiceA = made.value.number;
    else invoiceB = made.value.number;
  }
});

test('office enters a cheque with no order named: blind, and the oldest due invoice is paid first', async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.allocOffice.email);
  await goNav(page, 'payments-new-link');
  await page.getByTestId('payment-search').fill(clientName);
  await page.getByTestId('payment-party').selectOption({ index: 1 });
  await page.getByTestId('payment-method').selectOption('cheque');
  await page.getByTestId('payment-amount').fill('3 000,00');
  await page.getByTestId('payment-number').fill(`AL${suffix}1`);
  await page.getByTestId('payment-bank').fill('Banque fictive');
  await page.getByTestId('payment-written').fill('2099-07-03');
  await page.getByTestId('payment-save').click();
  await expect(page.getByTestId('payment-saved')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(MONEY);
  await logout(page);
});

test('the owner reads the states: B (due first) paid, A partly; then directs a cheque to A with a reason', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'invoices-link');
  await expect(page.getByTestId(`invoice-payment-${invoiceB}`)).toContainText('Payée');
  await expect(page.getByTestId(`invoice-payment-${invoiceA}`)).toContainText('Partiellement');

  // a second cheque, received by the owner for the client without being spread
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const client = (await migrator.query<{ id: string }>(`select id from client where name = $1`, [clientName]))
    .rows[0];
  const second = await receiveInstrument(
    app,
    owner,
    {
      clientId: client?.id,
      method: 'cheque',
      amountCentimes: 100_000,
      number: `AL${suffix}2`,
      bank: 'Banque fictive',
      writtenDate: '2099-07-03',
    },
    { today: '2099-07-03' },
  );
  expect(second.ok).toBe(true);

  await goNav(page, 'instruments-link');
  const row = page.getByTestId(`instrument-AL${suffix}2`);
  await row.getByTestId('allocate-open').click();
  // only A is still open for this client, so it is the one offered
  await row.getByTestId('allocate-invoice').selectOption({ index: 0 });
  await row.getByTestId('allocate-reason').fill('Le client a demandé cette facture');
  await row.getByTestId('allocate-confirm').click();
  await expect(row.getByTestId('allocate-form')).toHaveCount(0);
  await expect(row.getByTestId('allocate-error')).toHaveCount(0);
  const tagged = await migrator.query<{ n: string; reason: string }>(
    `select count(*)::text as n, max(a.override_reason) as reason from allocation a
       join payment_instrument i on i.id = a.instrument_id where i.number = $1 and a.invoice_id is not null`,
    [`AL${suffix}2`],
  );
  expect(tagged.rows[0]).toMatchObject({ n: '1', reason: 'Le client a demandé cette facture' });
  await goNav(page, 'invoices-link');
  await expect(page.getByTestId(`invoice-payment-${invoiceA}`)).toContainText('Partiellement');
  await logout(page);
});
