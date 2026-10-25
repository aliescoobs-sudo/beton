import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { createLoad } from '../src/modules/operations';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { deliveryScene, type DeliveryScene } from '../tests/helpers/ledger-fixtures';
import { E2E_MD, loginAndEnrol, loginOwner } from './fixtures';

// operations O14 (AC-OPS-23): concrete refused or brought back is recorded on its load with a reason, once, and counted as loss
// in the consumption report.
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));

const DAY = '2096-06-10';
let scene: DeliveryScene;
let typeLabel = '';
let blA = '';
let blB = '';
const MONEY = /MAD|DH|\d\s?\d{3},\d{2}/;

test.beforeAll(async () => {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const plant = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'plant');
  scene = await deliveryScene(app, owner.id, `e2elo${randomUUID().replace(/-/g, '').slice(0, 8)}`);
  typeLabel = (
    await migrator.query<{ label: string }>(`select label from concrete_type where id = $1`, [scene.typeId])
  ).rows[0]?.label as string;
  for (const [volumeL, set] of [
    [8000, (bl: string) => (blA = bl)],
    [2000, (bl: string) => (blB = bl)],
  ] as const) {
    const l = await createLoad(
      app,
      plant,
      { orderId: scene.orderId, truckId: scene.truckId, volumeL },
      { today: DAY },
    );
    if (!l.ok) throw new Error(l.error);
    set(l.value.blNo);
  }
});

test('the plant marks 3 m³ of a load as too old, once, and it shows on the load', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.lossPlant.email);
  await page.goto('/fr/loads');
  await page.getByTestId(`loss-open-${blA}`).click();
  await page.getByTestId(`loss-reason-${blA}`).selectOption('too_old');
  await page.getByTestId(`loss-m3-${blA}`).fill('3');
  await page.getByTestId(`loss-submit-${blA}`).click();
  await expect(page.getByTestId(`loss-${blA}`)).toContainText('Perdu : 3 m³');
  await expect(page.getByTestId(`loss-${blA}`)).toContainText('Trop vieux');
  // once only: the button is gone
  await expect(page.getByTestId(`loss-open-${blA}`)).toHaveCount(0);
  // more than the load is refused
  await page.getByTestId(`loss-open-${blB}`).click();
  await page.getByTestId(`loss-m3-${blB}`).fill('9');
  await page.getByTestId(`loss-submit-${blB}`).click();
  await expect(page.getByTestId(`loss-error-${blB}`)).toContainText('Plus que le chargement');
  await expect(page.locator('body')).not.toContainText(MONEY);
});

test('office marks a whole load as refused by the client; the report counts both as loss', async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.lossOffice.email);
  await page.goto('/fr/loads');
  await page.getByTestId(`loss-open-${blB}`).click();
  await page.getByTestId(`loss-reason-${blB}`).selectOption('rejected_by_client');
  await page.getByTestId(`loss-submit-${blB}`).click();
  await expect(page.getByTestId(`loss-${blB}`)).toContainText('Perdu : 2 m³');
});

test('the report shows the lost litres and the components they used, inside the production', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await page.goto(`/fr/reports/consumption?from=${DAY}&to=${DAY}&period=day`);
  await expect(page.getByTestId(`produced-${DAY}-${typeLabel}`)).toContainText('10 m³');
  await expect(page.getByTestId(`loss-${DAY}-${typeLabel}`)).toContainText('5 m³');
  await expect(page.getByTestId('loss-components')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(MONEY);
});
