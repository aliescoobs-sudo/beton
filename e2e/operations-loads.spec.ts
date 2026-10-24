import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { testEnv } from '../tests/db-env';
import { deliveryScene, type DeliveryScene } from '../tests/helpers/ledger-fixtures';
import { E2E_MD, goNav, loginAndEnrol, logout } from './fixtures';

// operations O4: the plant loads an order from the day's list; no price, total or client contact anywhere on the screens.
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));
let scene: DeliveryScene;
let orderCode = '';

test.beforeAll(async () => {
  const owner = (await migrator.query<{ id: string }>(`select id from "user" where role = 'owner'`)).rows[0];
  scene = await deliveryScene(app, owner?.id as string, `e2eld${randomUUID().replace(/-/g, '').slice(0, 8)}`);
  orderCode = (
    await migrator.query<{ code: string }>(`select code from sales_order where id = $1`, [scene.orderId])
  ).rows[0]?.code as string;
});

test('the plant loads an order, gets a BL number, marks the signed BL back, and sees no money', async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.loadPlant.email);
  await goNav(page, 'loads-link');
  await expect(page).toHaveURL('/fr/loads');
  await expect(page.getByTestId(`due-${orderCode}`)).toBeVisible();
  await page.getByTestId(`load-m3-${orderCode}`).fill('8');
  await page.getByTestId(`load-create-${orderCode}`).click();
  const done = page.getByTestId(`load-done-${orderCode}`);
  await expect(done).toContainText(/BL-\d{4}-\d{5}/);
  const blNo = /BL-\d{4}-\d{5}/.exec((await done.textContent()) ?? '')?.[0] as string;
  await expect(page.getByTestId(`delivery-${blNo}`)).toBeVisible();
  await page.getByTestId(`bl-return-${blNo}`).click();
  await expect(page.getByTestId(`delivery-${blNo}`)).toContainText('Rentré le');
  await expect(page.locator('body')).not.toContainText(/MAD|DH|\d\s?\d{3},\d{2}/);

  await page.getByTestId(`note-link-${blNo}`).click();
  await expect(page.getByTestId('delivery-note')).toContainText(blNo);
  await expect(page.getByTestId('delivery-note')).toContainText(orderCode);
  await expect(page.getByTestId('delivery-note')).toContainText('Signature du chauffeur');
  await expect(page.locator('body')).not.toContainText(/MAD|DH|\d\s?\d{3},\d{2}/);
  await page.goto('/fr/loads');

  await goNav(page, 'stock-link');
  await expect(page).toHaveURL('/fr/stock');
  await expect(page.getByTestId('stock-levels')).toBeVisible();
  await logout(page);
});

test('office sees the loads and the delivery list but cannot load, and has no stock page', async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.loadOffice.email);
  await page.goto('/fr/loads');
  await expect(page.getByTestId('deliveries-list')).toBeVisible();
  await expect(page.locator('[data-testid^="load-create-"]')).toHaveCount(0);
  expect((await page.goto('/fr/stock'))?.status()).toBe(404);
});

test('Arabic: right-to-left, codes and volumes left-to-right', async ({ page }) => {
  await loginAndEnrol(page, 'ar', E2E_MD.loadPlantAr.email);
  await page.goto('/ar/loads');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('deliveries-list').locator('bdi[dir="ltr"]').first()).toBeVisible();
  await page.goto('/ar/stock');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('stock-levels')).toBeVisible();
});
