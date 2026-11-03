import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { deliveryScene, insertOrder, orderMaster } from '../tests/helpers/ledger-fixtures';
import { E2E_MD, loginAndEnrol } from './fixtures';

// C3 (REQUIREMENTS-V1 §16.6): the office marks a pour as pumped, sees it wait for a pump, schedules the pump on site, and reads the
// board on a phone. The refusal of a truck before the pump is proved in the database tests.
const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));

const marker = `e2epu${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const DAY = '2026-06-04';
let orderCode = '';

test.beforeAll(async () => {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const scene = await deliveryScene(app, owner.id, marker, DAY);
  const master = await orderMaster(app, owner.id, marker);
  await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, async (tx) => {
    orderCode = (await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, DAY)).code;
    await tx.query(
      `insert into truck (id, code, plate, kind) values (gen_random_uuid(), 'P' || ($1::int % 800 + 100), $2, 'pump')`,
      [Math.floor(Math.random() * 1e6), `PU-${marker}`],
    );
    await tx.query(
      `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), 'CH-' || ($1::int % 8000 + 1000), $2, $3, 'pump_operator')`,
      [Math.floor(Math.random() * 1e6), `Opérateur ${marker}`, owner.id],
    );
  });
});

test('the office marks a pour as pumped, schedules the pump on site and reads the board on a phone', async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.pumpOffice.email);
  await page.goto(`/fr/pumps?date=${DAY}`);
  await expect(page.getByTestId('pump-none')).toBeVisible();
  await page.getByTestId('pump-mark-code').fill(orderCode);
  await page.getByTestId('pump-mark-save').click();
  await expect(page.getByTestId(`pump-waiting-${orderCode}`)).toBeVisible();
  await expect(page.getByTestId(`pump-waiting-${orderCode}`)).toContainText(
    'Aucun camion ne peut être planifié avant la pompe',
  );
  await page.getByTestId(`pump-pick-${orderCode}`).click();
  await expect(page.getByTestId('pump-order')).toHaveValue(/.+/);
  await page.getByTestId('pump-onsite').fill('07:30');
  await page.getByTestId('pump-site').fill('Chantier E2E');
  await page.getByTestId('pump-save').click();
  await expect(page.getByTestId(`pump-waiting-${orderCode}`)).toHaveCount(0);
  const job = page.locator('[data-testid^="pump-job-"]').first();
  await expect(job).toBeVisible();
  await expect(job).toContainText('07:30');
  await expect(job).toContainText('08:00'); // ready after the 30 minutes of set-up
  await expect(page.getByTestId('pump-no-conflict')).toBeVisible();
  expect(await page.locator('body').innerText()).not.toMatch(/MAD|DH|\d\s?\d{3},\d{2}/);
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
