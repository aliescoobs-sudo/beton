import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { testEnv } from '../tests/db-env';
import { insertPurchase, purchaseMaster } from '../tests/helpers/ledger-fixtures';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// integration I2.1: the supplier's invoice, linked to its order and receipts. Office enters it blind; the owner and support
// read it with the links to the order; the plant has nothing (AC-INT-13, AC-INT-24).
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));
const MONEY = /MAD|DH|\d\s?\d{3},\d{2}/;
let poCode = '';
let poId = '';
let componentId = '';
let supplierNo = '';
let code = '';

test.beforeAll(async () => {
  const ownerId = (await migrator.query<{ id: string }>(`select id from "user" where role = 'owner'`)).rows[0]
    ?.id as string;
  const master = await purchaseMaster(app, ownerId, `e2esi${randomUUID().replace(/-/g, '').slice(0, 8)}`);
  await withRlsContext(app, { userId: ownerId, role: 'owner', requestId: 'e2e-si' }, async (tx) => {
    const supplier = await tx.query<{ id: string }>(
      `insert into supplier (id, code, name, category) values (gen_random_uuid(), public.next_code('FRN', 2), $1, 'cement') returning id`,
      [`e2e si ${randomUUID().slice(0, 8)}`],
    );
    const po = await insertPurchase(tx, ownerId, { ...master, supplierId: supplier.rows[0]?.id as string });
    await tx.query(`select public.record_receipt($1, '2026-06-02')`, [po.id]);
    poCode = po.code;
    poId = po.id;
  });
  componentId = master.componentId;
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
