import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { createLoad } from '../src/modules/operations';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import {
  deliveryScene,
  type DeliveryScene,
  newReceivablePurchase,
  purchaseMaster,
} from '../tests/helpers/ledger-fixtures';
import { loginOwner } from './fixtures';

// Review of CP-OPS-1-3: partial receipts and the over-receipt confirmation, a load past its order (confirmed by the owner on
// the dashboard), the load-cancellation screen and the stock count correction. Everything the owner does asks for nothing
// more than the session he just opened (a fresh second factor).
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));

const marker = `e2erv${randomUUID().replace(/-/g, '').slice(0, 8)}`;
let scene: DeliveryScene;
let orderCode = '';
let loads: { bl: string; id: string }[] = [];
let purchases: { id: string; code: string; lineId: string }[] = [];

async function newPurchase() {
  const owner = (await migrator.query<{ id: string }>(`select id from "user" where role = 'owner'`)).rows[0];
  const master = await purchaseMaster(app, owner?.id as string, marker);
  const p = await newReceivablePurchase(app, owner?.id as string, master, marker);
  const line = (
    await migrator.query<{ id: string }>(`select id from purchase_line where purchase_id = $1 limit 1`, [
      p.id,
    ])
  ).rows[0];
  return { id: p.id, code: p.code, lineId: line?.id as string };
}

test('data: two purchases to receive, an order loaded past its volume', async () => {
  purchases = [await newPurchase(), await newPurchase()];
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const plant = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'plant');
  scene = await deliveryScene(app, owner.id, marker);
  orderCode = (
    await migrator.query<{ code: string }>(`select code from sales_order where id = $1`, [scene.orderId])
  ).rows[0]?.code as string;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(new Date());
  loads = [];
  for (const volumeL of [8000, 4000]) {
    const l = await createLoad(
      app,
      plant,
      { orderId: scene.orderId, truckId: scene.truckId, volumeL },
      { today },
    );
    if (!l.ok) throw new Error(l.error);
    loads.push({ bl: l.value.blNo, id: l.value.id });
    if (volumeL === 4000) expect(l.value.excessL).toBe(2000);
  }
});

test("partial receipts: part now, the rest later; more than ordered needs the owner's confirmation", async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  const [first, second] = purchases as [(typeof purchases)[number], (typeof purchases)[number]];
  await page.goto('/fr/receipts');
  await page.getByTestId(`receive-partial-${first.code}`).click();
  await page.getByTestId(`receive-qty-${first.code}-${first.lineId}`).fill('12');
  await page.getByTestId(`receive-submit-${first.code}`).click();
  await expect(page.getByTestId(`receipt-done-${first.code}`)).toBeVisible();
  await page.getByTestId(`receipt-continue-${first.code}`).click();
  await expect(page.getByTestId(`partial-${first.code}`)).toBeVisible();
  await expect(page.getByTestId(`purchase-${first.code}`)).toContainText('12 / 30');
  await page.getByTestId(`receive-${first.code}`).click();
  await expect(page.getByTestId(`receipt-done-${first.code}`)).toBeVisible();
  await page.getByTestId(`receipt-continue-${first.code}`).click();
  await expect(page.getByTestId(`purchase-${first.code}`)).toContainText('Reçu le');

  // 31 t ordered 30: refused without the confirmation, accepted with it, and flagged
  await page.getByTestId(`receive-partial-${second.code}`).click();
  await page.getByTestId(`receive-qty-${second.code}-${second.lineId}`).fill('31');
  await page.getByTestId(`receive-submit-${second.code}`).click();
  await expect(page.getByTestId(`receive-error-${second.code}`)).toContainText('propriétaire');
  await page.getByTestId(`receive-excess-${second.code}`).check();
  await page.getByTestId(`receive-submit-${second.code}`).click();
  await expect(page.getByTestId(`receipt-done-${second.code}`)).toBeVisible();
  const flagged = await migrator.query(`select over_receipt from purchase_receipt where purchase_id = $1`, [
    second.id,
  ]);
  expect(flagged.rows).toEqual([{ over_receipt: true }]);
});

test('a load past its order is on the dashboard for the owner to confirm, then it is gone', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  const row = page.getByTestId('excess-section').locator('li', { hasText: orderCode });
  await expect(row).toBeVisible();
  await expect(row).toContainText('2 m³');
  await row.getByRole('button', { name: /Confirmer/ }).click();
  await expect(page.getByTestId('excess-section').locator('li', { hasText: orderCode })).toHaveCount(0);
});

test('the owner cancels a load from the loads screen, with a reason; its BL is marked cancelled', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await page.goto('/fr/loads');
  const target = loads[1] as { bl: string; id: string };
  await page.getByTestId(`cancel-load-${target.bl}`).click();
  await page.getByTestId(`cancel-reason-${target.bl}`).fill('erreur de saisie du chauffeur');
  await page.getByTestId(`cancel-confirm-${target.bl}`).click();
  await expect(page.getByTestId(`delivery-${target.bl}`)).toContainText('annulé', { ignoreCase: true });
  await expect(page.getByTestId(`cancel-load-${target.bl}`)).toHaveCount(0);
});

test('the owner corrects the stock after a count: a reason is mandatory and the correction is listed', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await page.goto('/fr/stock');
  await page.getByTestId(`count-open-${scene.cementId}`).click();
  await page.getByTestId(`count-qty-${scene.cementId}`).fill('5000');
  await page.getByTestId(`count-reason-${scene.cementId}`).fill('inventaire de fin de mois');
  await page.getByTestId(`count-save-${scene.cementId}`).click();
  await expect(page.getByTestId('adjustments-list')).toContainText('inventaire de fin de mois');
  await expect(page.getByTestId(`stock-${scene.cementId}`)).toContainText('5 000 kg');
});
