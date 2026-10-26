import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { allocate, createInvoice } from '../src/modules/ledger';
import { saveDispatch } from '../src/modules/operations';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import {
  clientWithLoads,
  deliveryScene,
  insertInstrument,
  orderMaster,
} from '../tests/helpers/ledger-fixtures';
import { withRlsContext } from '../src/lib/db/rls-context';
import { checkScreen, watch } from './screen-check';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// integration I3.1: the order chain. Every role reads quantities and stages; the paid stage and every amount are for the owner
// and support only (AC-INT-16, AC-INT-24).
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));
const MONEY = /MAD|DH|\d\s?\d{3},\d{2}/;
let code = '';

test.beforeAll(async () => {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const plant = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'plant');
  const marker = `e2eoc${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const scene = await deliveryScene(app, owner.id, marker);
  const master = await orderMaster(app, owner.id, marker);
  const c = await clientWithLoads(app, owner.id, master, scene, [[4000, 2000]]);
  const order = c.orders[0]!;
  code = order.code;
  await saveDispatch(app, plant, {
    date: '2026-06-02',
    rotations: [{ orderId: order.id, truckId: scene.truckId, driverId: null, volumeL: 4000 }],
  });
  const made = await createInvoice(
    app,
    owner,
    { deliveryIds: [order.deliveryIds[0]] },
    { today: '2026-07-03' },
  );
  if (!made.ok) throw new Error(made.error);
  const cheque = await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: 'e2e-oc' }, (tx) =>
    insertInstrument(tx, owner.id, { clientId: c.clientId, amountCentimes: 100_000 }),
  );
  await allocate(app, owner, { instrumentId: cheque.id, itemId: order.itemIds[0], amountCentimes: 100_000 });
});

test('the owner sees the six stages of the order, the payment included, and what it waits for', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'order-chain-link');
  await expect(page).toHaveURL('/fr/orders/chain');
  const row = page.getByTestId(`chain-${code}`);
  await expect(row).toContainText('10 m³');
  await expect(page.getByTestId(`chain-${code}-planned`)).toContainText('4 m³');
  await expect(page.getByTestId(`chain-${code}-loaded`)).toContainText('6 m³');
  await expect(page.getByTestId(`chain-${code}-delivered`)).toContainText('6 m³');
  await expect(page.getByTestId(`chain-${code}-invoiced`)).toContainText('4 m³');
  await expect(page.getByTestId(`chain-${code}-paid`)).toContainText('Partiellement');
  await expect(row).toHaveAttribute('data-waiting', 'planned');
  await expect(page.locator('body')).not.toContainText(/\d\s?\d{3},\d{2}/);
  await logout(page);
});

test('office sees the quantities and stages, the paid stage masked, and not one amount', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.chainOffice.email);
  await goNav(page, 'order-chain-link');
  const row = page.getByTestId(`chain-${code}`);
  await expect(row).toContainText('10 m³');
  await expect(page.getByTestId(`chain-${code}-invoiced`)).toContainText('4 m³');
  await expect(page.getByTestId(`chain-${code}-paid`)).not.toContainText('Partiellement');
  await expect(page.getByTestId(`chain-${code}-paid`)).toContainText('—');
  await expect(page.locator('body')).not.toContainText(MONEY);
  // the order number is a number, not a link, for a role that cannot open the order
  await expect(row.getByRole('link')).toHaveCount(0);
});

test('the plant sees the same, and the page reads right-to-left in Arabic on a phone and a desktop', async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.chainPlant.email);
  await goNav(page, 'order-chain-link');
  await expect(page.getByTestId(`chain-${code}-paid`)).toContainText('—');
  await expect(page.locator('body')).not.toContainText(MONEY);
  await logout(page);
  const problems = watch(page);
  await loginAndEnrol(page, 'ar', E2E_MD.chainPlantAr.email);
  await page.goto('/ar/orders/chain');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId(`chain-${code}`)).toBeVisible();
  await checkScreen(page, 'ar', 'order-chain');
  expect(problems).toEqual([]);
});
