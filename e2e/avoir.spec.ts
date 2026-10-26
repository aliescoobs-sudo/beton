import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { createInvoice } from '../src/modules/ledger';
import { recordLoss } from '../src/modules/operations';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { clientWithLoads, deliveryScene, orderMaster } from '../tests/helpers/ledger-fixtures';
import { checkScreen, watch } from './screen-check';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// integration I1.6: the avoir of refused concrete. The owner issues it (a reason; a fresh second factor), it shows on the
// client statement; support reads; office and plant have nothing (AC-INT-12, AC-INT-24).
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));
const MONEY = /MAD|DH|\d\s?\d{3},\d{2}/;
let blNo = '';
let invoiceNumber = '';
let clientId = '';
let avoirNumber = '';

test.beforeAll(async () => {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const plant = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'plant');
  const marker = `e2eav${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const scene = await deliveryScene(app, owner.id, marker);
  const master = await orderMaster(app, owner.id, marker);
  const c = await clientWithLoads(app, owner.id, master, scene, [[6000]]);
  clientId = c.clientId;
  blNo = c.orders[0]?.blNos[0] as string;
  const made = await createInvoice(
    app,
    owner,
    { deliveryIds: c.orders[0]?.deliveryIds },
    { today: new Date().toISOString().slice(0, 10) },
  );
  if (!made.ok) throw new Error(made.error);
  invoiceNumber = made.value.number;
  const loss = await recordLoss(app, plant, {
    deliveryId: c.orders[0]?.deliveryIds[0],
    volumeL: 2000,
    reason: 'rejected_by_client',
  });
  if (!loss.ok) throw new Error(loss.error);
});

test('the owner sees the refused load waiting for its avoir, issues it with a reason, and it shows on the statement', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'avoirs-link');
  await expect(page).toHaveURL('/fr/avoirs');
  const todo = page.getByTestId(`avoir-todo-${blNo}`);
  await expect(todo).toContainText(invoiceNumber);
  await expect(todo).toContainText('2 m³');
  await expect(todo).toContainText('1 872,00');
  await todo.getByTestId('avoir-open').click();
  await todo.getByTestId('avoir-reason').fill('Béton refusé par le client sur le chantier');
  await todo.getByTestId('avoir-confirm').click();
  await expect(page.getByTestId(`avoir-todo-${blNo}`)).toHaveCount(0);
  const issued = page.getByTestId('avoir-list').locator('tr', { hasText: blNo });
  await expect(issued).toContainText(invoiceNumber);
  await expect(issued).toContainText('1 872,00');
  avoirNumber = /AV-\d{4}-\d{5}/.exec((await issued.textContent()) ?? '')?.[0] as string;
  expect(avoirNumber).toMatch(/^AV-/);

  // the client statement carries it, as a line that lowers the balance
  await page.goto(`/fr/statements/client/${clientId}`);
  await expect(page.locator('body')).toContainText(avoirNumber);
  await expect(page.locator('body')).toContainText('-1 872,00');
  await logout(page);
});

test('support reads the avoirs and cannot issue; office has no link and no page', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.avoirSupport.email);
  await goNav(page, 'avoirs-link');
  await expect(page.getByTestId(`avoir-${avoirNumber}`)).toBeVisible();
  await expect(page.locator('[data-testid="avoir-open"]')).toHaveCount(0);
  await logout(page);

  await loginAndEnrol(page, 'fr', E2E_MD.avoirOffice.email);
  await expect(page.getByTestId('avoirs-link')).toHaveCount(0);
  expect((await page.goto('/fr/avoirs'))?.status()).toBe(404);
  await expect(page.locator('body')).not.toContainText(MONEY);
});

test('Arabic: right-to-left, codes left-to-right, no CSP violation (the owner)', async ({ browser }) => {
  const page = await browser.newPage();
  const problems = watch(page);
  await loginOwner(page, 'ar');
  await page.goto('/ar/avoirs');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId(`avoir-${avoirNumber}`)).toBeVisible();
  await checkScreen(page, 'ar', 'avoirs');
  expect(problems).toEqual([]);
  await page.close();
});
