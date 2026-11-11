import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { createLoad } from '../src/modules/operations';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { deliveryScene } from '../tests/helpers/ledger-fixtures';
import { E2E_MD, loginAndEnrol, loginOwner } from './fixtures';
import { checkScreen, watch } from './screen-check';

// operations O15 (AC-OPS-24): m³ delivered per period and type, client or zone; the amounts for the owner only, none for
// the partner, no page for the plant.
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));

const DAY = '2095-08-12';
const QUERY = 'from=2095-08-01&to=2095-08-31&period=day&by=type';
let typeLabel = '';
const MONEY = /MAD|DH|\d\s?\d{3},\d{2}/;

test.beforeAll(async () => {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const plant = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'plant');
  const scene = await deliveryScene(app, owner.id, `e2ean${randomUUID().replace(/-/g, '').slice(0, 8)}`);
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
});

test('the owner sees the m³ and the amount (8 m³ × 780,00 = 6 240,00 MAD HT)', async ({ page }) => {
  const problems = watch(page);
  await loginOwner(page, 'fr');
  await page.goto(`/fr/analytics?${QUERY}`);
  const row = page.getByTestId(`analytics-${DAY}-${typeLabel}`);
  await expect(row).toContainText('8 m³');
  await expect(row).toContainText('6 240,00');
  await expect(page.getByTestId('analytics-total')).toContainText('m³');
  await page.goto('/fr/analytics?from=2095-08-01&to=2095-08-31&period=month&by=client');
  await expect(page.getByTestId('analytics-table')).toContainText('CLT-');
  await page.goto('/ar/analytics?from=2095-08-01&to=2095-08-31&period=week&by=zone');
  await expect(page.getByTestId('analytics-table')).toBeVisible();
  await checkScreen(page, 'ar', 'analytics');
  expect(problems).toEqual([]);
});

test('the plant has no page and no link to the analytics', async ({ browser }) => {
  const plant = await browser.newPage();
  await loginAndEnrol(plant, 'fr', E2E_MD.anPlant.email);
  await expect(plant.getByTestId('analytics-link')).toHaveCount(0);
  expect((await plant.goto(`/fr/analytics?${QUERY}`))?.status()).toBe(404);
  await plant.close();
});
