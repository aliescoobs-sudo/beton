import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { testEnv } from '../tests/db-env';
import { createPurchase } from '../src/modules/ledger';
import { realSessionUser } from '../tests/helpers/actors';
import { purchaseMaster } from '../tests/helpers/ledger-fixtures';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// integration I2.1: the supplier's invoice, linked to its order and receipts. Office enters it blind; the owner and support
// read it with the links to the order; the plant has nothing (AC-INT-13, AC-INT-24).
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));
const MONEY = /MAD|DH|\d\s?\d{3},\d{2}/;
// A 1x1 PNG with a text chunk that must not survive (author), as a phone or a scanner app might write one.
const PNG_WITH_AUTHOR = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAFHRFWHRBdXRob3IAU0VDUkVULUFVVEhPUrJPzoEAAAAMSURBVHicY/jPwAAAAwEBAMn+ku8AAAAASUVORK5CYII=',
  'base64',
);
let poCode = '';
let poId = '';
let componentId = '';
let supplierNo = '';
let code = '';
let supplierId = '';

/** An order made the new way (no plan of its own) for a supplier of its own, received whole by the owner. */
async function newOrder(): Promise<{ id: string; code: string; supplierId: string }> {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const master = await purchaseMaster(app, owner.id, `e2esi${randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const supplier = await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: 'e2e-si' }, (tx) =>
    tx.query<{ id: string }>(
      `insert into supplier (id, code, name, category) values (gen_random_uuid(), public.next_code('FRN', 2), $1, 'cement') returning id`,
      [`e2e si ${randomUUID().slice(0, 8)}`],
    ),
  );
  const supplierId = supplier.rows[0]?.id as string;
  const made = await createPurchase(
    app,
    owner,
    {
      supplierId,
      lines: [
        {
          componentId: master.componentId,
          purchaseUnitId: master.unitId,
          qtyMilli: 30_000,
          unitPriceHtCentimes: 145_000,
        },
      ],
    },
    { today: '2026-06-01' },
  );
  if (!made.ok) throw new Error(made.error);
  await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: 'e2e-si' }, (tx) =>
    tx.query(`select public.record_receipt($1, '2026-06-02')`, [made.value.id]),
  );
  componentId = master.componentId;
  return { id: made.value.id, code: made.value.code, supplierId };
}

test.beforeAll(async () => {
  const po = await newOrder();
  poCode = po.code;
  poId = po.id;
  supplierId = po.supplierId;
  supplierNo = `E2E-${randomUUID().slice(0, 8).toUpperCase()}`;
});

test('office enters the supplier invoice for the order: blind, our code back, no amount', async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.siOffice.email);
  await goNav(page, 'supplier-invoices-new-link');
  await expect(page).toHaveURL('/fr/supplier-invoices/new');
  await page.getByTestId('si-purchase').fill(poCode);
  await page.getByTestId('si-no').fill(supplierNo);
  await page.getByTestId('si-component-0').selectOption(componentId);
  await page.getByTestId('si-qty-0').fill('30');
  await page.getByTestId('si-price-0').fill('1 450,00');
  // The AI reading is off: the form says so and offers nothing; the photo is just stored.
  await expect(page.getByTestId('si-ai-note')).toContainText('désactivée');
  await page
    .getByTestId('si-file')
    .setInputFiles({ name: 'facture.png', mimeType: 'image/png', buffer: PNG_WITH_AUTHOR });
  await page.getByTestId('si-save').click();
  const saved = page.getByTestId('si-saved');
  await expect(saved).toContainText(/FF-\d{4}-\d{5}/);
  code = /FF-\d{4}-\d{5}/.exec((await saved.textContent()) ?? '')?.[0] as string;
  await expect(page.locator('body')).not.toContainText(MONEY);
  // the same supplier number again is refused with a plain message
  await page.getByTestId('si-another').click();
  await page.getByTestId('si-purchase').fill(poCode);
  await page.getByTestId('si-no').fill(supplierNo);
  await page.getByTestId('si-component-0').selectOption(componentId);
  await page.getByTestId('si-qty-0').fill('30');
  await page.getByTestId('si-price-0').fill('1 450,00');
  await page.getByTestId('si-save').click();
  await expect(page.getByTestId('si-error')).toBeVisible();
  // office has no list
  await expect(page.getByTestId('supplier-invoices-link')).toHaveCount(0);
  expect((await page.goto('/fr/supplier-invoices'))?.status()).toBe(404);
});

test('the owner reads it: amounts, the order and the receipt it is linked to', async ({ page }) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'supplier-invoices-link');
  await expect(page.getByTestId(`si-${code}`)).toContainText('52 200,00');
  await expect(page.getByTestId(`si-state-${code}`)).toContainText('Saisie');
  await page.getByTestId(`si-open-${code}`).click();
  await expect(page.getByTestId('si-totals')).toContainText('43 500,00');
  await expect(page.getByTestId('si-totals')).toContainText('8 700,00');
  await expect(page.getByTestId('si-purchase-link')).toContainText(poCode);
  await expect(page.getByTestId('si-receipts-list')).toContainText('2026-06-02');
  // the photo office attached: opened through the authorized route, without its metadata
  const link = page.getByTestId('si-file-1');
  await expect(link).toBeVisible();
  const doc = await page.request.get((await link.getAttribute('href')) as string);
  expect(doc.status()).toBe(200);
  expect(doc.headers()['content-type']).toBe('image/png');
  expect(doc.headers()['x-content-type-options']).toBe('nosniff');
  expect((await doc.body()).includes(Buffer.from('SECRET'))).toBe(false);
  await page.getByTestId('si-purchase-link').click();
  await expect(page).toHaveURL(new RegExp(`/fr/purchases/${poId}`));
  await logout(page);
});

test('support reads it and cannot enter; the plant has nothing', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.siSupport.email);
  await goNav(page, 'supplier-invoices-link');
  await expect(page.getByTestId(`si-${code}`)).toBeVisible();
  await expect(page.getByTestId('supplier-invoices-new-link')).toHaveCount(0);
  expect((await page.goto('/fr/supplier-invoices/new'))?.status()).toBe(404);
});

test('the plant has no link and no page', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.siPlant.email);
  await expect(page.getByTestId('supplier-invoices-link')).toHaveCount(0);
  expect((await page.goto('/fr/supplier-invoices'))?.status()).toBe(404);
});

test('the owner sees a clean match, approves for payment, and the payable appears on the order and the statement', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'supplier-invoices-link');
  await page.getByTestId(`si-open-${code}`).click();
  await expect(page.getByTestId('si-match-summary')).toContainText('Aucun écart');
  await expect(page.getByTestId('si-flags-1')).toContainText('Conforme');
  await expect(page.getByTestId('si-accept')).toHaveCount(0);
  await page.getByTestId('si-approve').click();
  await page.getByTestId('si-confirm').click();
  await expect(page.getByTestId('si-decisions')).toHaveCount(0);
  await expect(page.getByTestId('si-events-list')).toContainText('Approuvée pour paiement');
  await page.getByTestId('si-purchase-link').click();
  await expect(page.getByTestId('purchase-plan')).toContainText('52 200,00');
  await expect(page.getByTestId('purchase-no-payable')).toHaveCount(0);
  await page.goto(`/fr/statements/supplier/${supplierId}`);
  await expect(page.locator('body')).toContainText(code);
  await expect(page.locator('body')).toContainText('Facture fournisseur approuvée');
  await logout(page);
});

test('an invoice with a gap: flagged, approval waits for the owner to accept it with a reason', async ({
  page,
}) => {
  const second = await newOrder();
  const no = `E2E-${randomUUID().slice(0, 8).toUpperCase()}`;
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const { createSupplierInvoice } = await import('../src/modules/ledger');
  const made = await createSupplierInvoice(
    app,
    owner,
    {
      purchaseCode: second.code,
      supplierInvoiceNo: no,
      invoiceDate: '2026-06-03',
      lines: [{ componentId, qtyMilli: 30_000, unitPriceHtCentimes: 150_000 }],
    },
    { today: '2026-06-10' },
  );
  if (!made.ok) throw new Error(made.error);
  await loginOwner(page, 'fr');
  await page.goto(`/fr/supplier-invoices/${made.value.id}`);
  await expect(page.getByTestId('si-flags-1')).toContainText('Prix différent');
  await expect(page.getByTestId('si-match-summary')).toContainText('écart');
  // no way to approve before the gap is accepted
  await expect(page.getByTestId('si-approve')).toHaveCount(0);
  await page.getByTestId('si-accept').click();
  await page.getByTestId('si-reason').fill('Hausse du ciment annoncée');
  await page.getByTestId('si-confirm').click();
  await expect(page.getByTestId('si-events-list')).toContainText(
    'Écarts acceptés — Hausse du ciment annoncée',
  );
  await page.getByTestId('si-approve').click();
  await page.getByTestId('si-confirm').click();
  await expect(page.getByTestId('si-events-list')).toContainText('Approuvée pour paiement');
});
