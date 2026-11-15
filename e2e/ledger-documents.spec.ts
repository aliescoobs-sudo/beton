import { expect, test } from '@playwright/test';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { createLoad, markDelivered } from '../src/modules/operations';
import { goNav, loginOwner } from './fixtures';

// ledger L29 + L30 + L19 + L32: our legal identity on the documents, the invoice as a printable document (print audited),
// the legal deadlines, and the accountant's files.
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));

test('the owner enters the legal identity, invoices a delivered order, prints it, and downloads the accountant files', async ({
  page,
}) => {
  await loginOwner(page, 'fr');

  // Our legal identity: ICE, IF, RC, patente, address, RIB.
  await goNav(page, 'company-link');
  await page.getByTestId('company-legalName').fill('KAYAS E2E (fictif)');
  await page.getByTestId('company-legalForm').fill('SARL');
  await page.getByTestId('company-ice').fill('001234567000089');
  await page.getByTestId('company-ifNumber').fill('12345678');
  await page.getByTestId('company-rcNumber').fill('TET-45678');
  await page.getByTestId('company-patente').fill('98765432');
  await page.getByTestId('company-address').fill('Zone industrielle, Tétouan (fictif)');
  await page.getByTestId('company-rib').fill('181 780 0000123456789012 34');
  await page.getByTestId('company-save').click();
  await expect(page.getByTestId('company-message')).toContainText('Version enregistrée');
  await expect(page.getByTestId('company-current')).toContainText('ICE 001234567000089');

  // An order, loaded by the plant, invoiced by the owner.
  await page.goto('/fr/orders/new');
  await page.getByTestId('order-client-search').fill('Atlas');
  await page.getByTestId('order-client').selectOption({ index: 1 });
  await page.getByTestId('order-type').selectOption({ label: 'B25 · Béton B25' });
  await page.getByTestId('order-volume').fill('6');
  await page.getByTestId('order-method').selectOption('GOULOTTE');
  await page.getByTestId('order-preset').selectOption('cash');
  await page.getByTestId('order-save').click();
  const code = /CMD-\d{4}-\d{5}/.exec(
    (await page.getByTestId('order-saved').textContent()) ?? '',
  )?.[0] as string;
  const row = (
    await migrator.query<{ id: string; truck: string }>(
      `select o.id, (select id from truck where code = 'T1') as truck from sales_order o where o.code = $1`,
      [code],
    )
  ).rows[0];
  const plant = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'plant');
  const load = await createLoad(
    app,
    plant,
    { orderId: row?.id, truckId: row?.truck, volumeL: 6000 },
    { today: new Date().toISOString().slice(0, 10) },
  );
  expect(load.ok).toBe(true);
  // Only a delivered load is billed.
  if (load.ok) await markDelivered(app, plant, { deliveryId: load.value.id }, { now: new Date() });
  await page.goto('/fr/invoices/new');
  await page.getByTestId('invoice-order-code').fill(code);
  await page.getByTestId('invoice-save').click();
  const number = /FA-\d{4}-\d{5}/.exec(
    (await page.getByTestId('invoice-saved').textContent()) ?? '',
  )?.[0] as string;

  // The document: our mentions, the client, the lines, HT / VAT / TTC at 6 m³ x 820,00 (the client's override).
  await goNav(page, 'invoices-link');
  await page.getByTestId(`invoice-open-${number}`).click();
  const doc = page.getByTestId('invoice-document');
  await expect(doc).toContainText('KAYAS E2E (fictif) (SARL)');
  await expect(doc).toContainText('ICE 001234567000089');
  await expect(doc).toContainText('RIB 181 780 0000123456789012 34');
  await expect(doc).toContainText(number);
  await expect(page.getByTestId('invoice-totals')).toContainText('4 920,00');
  await expect(page.getByTestId('invoice-totals')).toContainText('984,00');
  await expect(page.getByTestId('invoice-totals')).toContainText('5 904,00');
  await expect(page.getByTestId('invoice-terms')).toContainText('60 jours');
  // The print is audited as an export (the browser's own dialog is stubbed).
  await page.evaluate(() => {
    window.print = () => undefined;
  });
  await page.getByTestId('invoice-print').click();
  await expect
    .poll(async () =>
      Number(
        (
          await migrator.query<{ n: string }>(
            `select count(*)::text as n from audit_event where action = 'export' and table_name = $1`,
            [`print:invoice:${number}`],
          )
        ).rows[0]?.n,
      ),
    )
    .toBe(1);

  // The legal deadlines: the invoice is to collect on its due date.
  await goNav(page, 'deadlines-link');
  await expect(page.getByTestId('deadlines-receivable_due')).toContainText(number);

  // The accountant's files: the period, four downloads, an audited export.
  await goNav(page, 'accounting-link');
  await expect(page.getByTestId('accounting-reconciled')).toBeVisible();
  const href = (await page.getByTestId('accounting-sales').getAttribute('href')) as string;
  const sales = await page.request.get(href);
  expect(sales.headers()['content-type']).toContain('text/csv');
  expect(await sales.text()).toContain(`${number};`);
  const ageing = await page.request.get(
    (await page.getByTestId('accounting-ageing').getAttribute('href')) as string,
  );
  expect(await ageing.text()).toContain('Créances clients');
  expect(
    Number(
      (
        await migrator.query<{ n: string }>(
          `select count(*)::text as n from audit_event where action = 'export' and table_name like 'export:accounting-%'`,
        )
      ).rows[0]?.n,
    ),
  ).toBeGreaterThanOrEqual(2);

  // The delivery note carries our mentions too.
  await page.goto('/fr/loads');
  await page
    .getByRole('link', { name: /BL-\d{4}-\d{5}/ })
    .first()
    .click();
  await expect(page.getByTestId('note-company')).toContainText('ICE 001234567000089');

  // Arabic: right-to-left, numbers left-to-right.
  await page.goto(`/ar/invoices`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByTestId(`invoice-open-${number}`).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('invoice-totals').locator('bdi[dir="ltr"]').first()).toBeVisible();
});
