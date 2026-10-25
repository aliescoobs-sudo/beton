import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { adjustStockAfterCount, createLoad, periodKey } from '../src/modules/operations';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { deliveryScene, type DeliveryScene } from '../tests/helpers/ledger-fixtures';
import { E2E_MD, goNav, loginAndEnrol } from './fixtures';
import { checkScreen, watch } from './screen-check';

// operations O11 (AC-OPS-18, 19): production per type and theoretical consumption per component against the counts, read by
// the plant and the partner (quantities only), refused to office.
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));

const DAY = '2097-04-08';
const QUERY = `from=2097-04-01&to=2097-04-30&period=week`;
const WEEK = periodKey(DAY, 'week');
let scene: DeliveryScene;
let typeLabel = '';
const MONEY = /MAD|DH|\d\s?\d{3},\d{2}/;

test.beforeAll(async () => {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const plant = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'plant');
  scene = await deliveryScene(app, owner.id, `e2ecr${randomUUID().replace(/-/g, '').slice(0, 8)}`);
  typeLabel = (
    await migrator.query<{ label: string }>(`select label from concrete_type where id = $1`, [scene.typeId])
  ).rows[0]?.label as string;
  const l = await createLoad(
    app,
    plant,
    { orderId: scene.orderId, truckId: scene.truckId, volumeL: 8000 },
    { today: DAY },
  );
  if (!l.ok) throw new Error(l.error);
  // a count finds less than the books say (or nothing, when the books are below the gap)
  const levels = await migrator.query<{ level: string }>(
    `select coalesce(sum(qty_base), 0)::text as level from stock_movement where component_id = $1`,
    [scene.cementId],
  );
  const level = Number(levels.rows[0]?.level);
  const counted = level - 56_000 >= 0 ? level - 56_000 : level === 0 ? 1 : 0;
  const c = await adjustStockAfterCount(
    app,
    owner,
    { componentId: scene.cementId, countedBase: counted, reason: 'inventaire e2e' },
    { today: DAY },
  );
  if (!c.ok) throw new Error(c.error);
});

test('the plant reads the production and the consumption of the week, with the count, and no money', async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.repPlant.email);
  await goNav(page, 'consumption-report-link');
  await page.goto(`/fr/reports/consumption?${QUERY}`);
  await expect(page.getByTestId(`produced-${WEEK}-${typeLabel}`)).toContainText('8 m³');
  const row = page.getByTestId(`consumption-${WEEK}-${scene.cementId}`);
  await expect(row).toBeVisible();
  // 350 kg × 8 m³ = 2 800 kg the recette says was used; the count of the week is shown beside it
  await expect(row).toContainText('2 800 kg');
  await expect(row).toContainText(/Écart à vérifier|Dans la tolérance/);
  await expect(row).not.toContainText('Pas d’inventaire');
  await expect(page.locator('body')).not.toContainText(MONEY);
  // the same week as days: the load is on its own day
  await page.goto(`/fr/reports/consumption?from=2097-04-01&to=2097-04-30&period=day`);
  await expect(page.getByTestId(`produced-${DAY}-${typeLabel}`)).toBeVisible();
});

test('the partner reads it too; office has no page and no link; Arabic renders right-to-left', async ({
  page,
  browser,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.repPartner.email);
  await page.goto(`/fr/reports/consumption?${QUERY}`);
  await expect(page.getByTestId('consumption-table')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(MONEY);

  const office = await browser.newPage();
  await loginAndEnrol(office, 'fr', E2E_MD.repOffice.email);
  await expect(office.getByTestId('consumption-report-link')).toHaveCount(0);
  expect((await office.goto(`/fr/reports/consumption?${QUERY}`))?.status()).toBe(404);
  await office.close();

  const ar = await browser.newPage();
  const problems = watch(ar);
  await loginAndEnrol(ar, 'ar', E2E_MD.repPlantAr.email);
  await ar.goto(`/ar/reports/consumption?${QUERY}`);
  await expect(ar.getByTestId('consumption-table')).toBeVisible();
  await checkScreen(ar, 'ar', 'consumption-report');
  expect(problems).toEqual([]);
  await ar.close();
});
