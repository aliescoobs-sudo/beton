import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { testEnv } from '../tests/db-env';
import { insertOrder, orderMaster } from '../tests/helpers/ledger-fixtures';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// operations O9 (AC-OPS-12…15): the owner opens the day's plan, sees the proposal and its times, adds a driver, sees a
// conflict when one driver is on two rotations, cannot save a plan with a truck in the breakdown log, saves, and the plant
// reads and plans too; office has no page; no money anywhere.
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));

/** A day of its own: this spec's order is the only one due, so the proposal and its times are deterministic. */
const DAY = '2099-03-02';
const DAY2 = '2099-03-09';
let orderCode = '';
let orderCode2 = '';
let brokenTruck = '';
const MONEY = /MAD|DH|\d\s?\d{3},\d{2}/;

test.beforeAll(async () => {
  const owner = (await migrator.query<{ id: string }>(`select id from "user" where role = 'owner'`)).rows[0];
  const ownerId = owner?.id as string;
  const master = await orderMaster(app, ownerId, `e2edp${randomUUID().replace(/-/g, '').slice(0, 8)}`);
  orderCode = (
    await withRlsContext(app, { userId: ownerId, role: 'owner', requestId: 'e2e-dispatch' }, (tx) =>
      insertOrder(tx, ownerId, master, DAY),
    )
  ).code;
  orderCode2 = (
    await withRlsContext(app, { userId: ownerId, role: 'owner', requestId: 'e2e-dispatch' }, (tx) =>
      insertOrder(tx, ownerId, master, DAY2),
    )
  ).code;
  // A truck of its own, in the breakdown log for the day.
  brokenTruck = `T${900 + Math.floor(Math.random() * 99)}`;
  await withRlsContext(app, { userId: ownerId, role: 'owner', requestId: 'e2e-dispatch' }, async (tx) => {
    const t = await tx.query<{ id: string }>(
      `insert into truck (id, code, plate, capacity_l) values (gen_random_uuid(), $1, $2, 8000) returning id`,
      [brokenTruck, `${brokenTruck}-E2E`],
    );
    await tx.query(
      `insert into truck_status_log (id, truck_id, status, from_date, to_date, reason, logged_by)
       values (gen_random_uuid(), $1, 'breakdown', $2, '2099-03-03', 'e2e', $3)`,
      [t.rows[0]?.id, DAY, ownerId],
    );
  });
});

test('the owner sees the proposal with its times, a conflict, a blocked truck, and saves the plan', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'dispatch-link');
  await page.goto(`/fr/dispatch?date=${DAY}`);
  await expect(page.getByTestId(`day-order-${orderCode}`)).toBeVisible();
  await expect(page.getByTestId('dispatch-source')).toContainText('Proposition');

  // 10 m³ on 8 m³ trucks: two rotations; the first one loads at the start of the day (07:00) and leaves 10 minutes later
  await expect(page.getByTestId(`rotation-${orderCode}-1`)).toBeVisible();
  await expect(page.getByTestId(`rotation-${orderCode}-2`)).toBeVisible();
  const times = page.getByTestId(`times-${orderCode}-1`);
  await expect(times).toContainText('Chargement 07:00');
  await expect(times).toContainText('départ 07:10');
  // the truck in the log is offered but marked, and never in the proposal
  await expect(page.getByTestId('dispatch-timeline')).toContainText(brokenTruck);
  await expect(page.getByTestId(`truck-${orderCode}-1`)).not.toHaveValue('');
  const proposed = await page.getByTestId(`truck-${orderCode}-1`).inputValue();
  const broken = await page
    .getByTestId(`truck-${orderCode}-1`)
    .locator('option', { hasText: brokenTruck })
    .getAttribute('value');
  expect(proposed).not.toBe(broken);

  // a driver, then the same driver on both rotations: DRIVER_OVERLAP
  await page.getByTestId('driver-name').fill('Karim');
  await page.getByTestId('driver-add').click();
  await expect(page.getByTestId('drivers-list')).toContainText('Karim');
  await page.getByTestId('dispatch-propose').click();
  const driverValue = await page
    .getByTestId(`driver-${orderCode}-1`)
    .locator('option', { hasText: 'Karim' })
    .getAttribute('value');
  await page.getByTestId(`driver-${orderCode}-1`).selectOption(driverValue as string);
  await page.getByTestId(`driver-${orderCode}-2`).selectOption(driverValue as string);
  await expect(page.locator('[data-conflict="DRIVER_OVERLAP"]')).toBeVisible();

  // a truck in the breakdown log blocks the save
  await page.getByTestId(`truck-${orderCode}-2`).selectOption(broken as string);
  await expect(page.locator('[data-conflict="TRUCK_BROKEN"][data-blocking="true"]')).toBeVisible();
  await expect(page.getByTestId('dispatch-save')).toBeDisabled();

  // back to a proposal, then save
  await page.getByTestId('dispatch-propose').click();
  await expect(page.locator('[data-conflict="TRUCK_BROKEN"]')).toHaveCount(0);
  await page.getByTestId('dispatch-save').click();
  await expect(page.getByTestId('dispatch-message')).toContainText('Plan enregistré');
  await page.reload();
  await expect(page.getByTestId('dispatch-source')).toContainText('Plan enregistré');
  await expect(page.getByTestId(`rotation-${orderCode}-1`)).toBeVisible();
  await expect(page.locator('body')).not.toContainText(MONEY);
  await logout(page);
});

test('the default driver of a truck is proposed; another driver needs a reason, kept with the rotation (AC-INT-20)', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await page.goto(`/fr/dispatch?date=${DAY2}`);
  await page.getByTestId('driver-name').fill('Nadia');
  await page.getByTestId('driver-add').click();
  await expect(page.getByTestId('drivers-list')).toContainText('Nadia');
  await page.getByTestId('driver-name').fill('Samir');
  await page.getByTestId('driver-add').click();
  await expect(page.getByTestId('drivers-list')).toContainText('Samir');

  // the truck the proposal gives to the first rotation gets Nadia as its default driver
  const truckSelect = page.getByTestId(`truck-${orderCode2}-1`);
  const truckCode = (await truckSelect.locator('option:checked').innerText()).split(' ·')[0] as string;
  const defaults = page.getByTestId(`default-select-${truckCode}`);
  await defaults.selectOption({ label: 'Nadia' });
  await expect(defaults.locator('option:checked')).toHaveText('Nadia');
  await page.reload();
  await expect(page.getByTestId(`default-select-${truckCode}`).locator('option:checked')).toHaveText('Nadia');

  // the proposal now carries Nadia on that truck, with no reason asked
  await expect(page.getByTestId(`driver-${orderCode2}-1`).locator('option:checked')).toHaveText('Nadia');
  await expect(page.getByTestId(`default-driver-${orderCode2}-1`)).toContainText('Nadia');
  await expect(page.getByTestId(`reason-${orderCode2}-1`)).toHaveCount(0);

  // another driver: a reason is asked and the save waits for it (text, not colour alone)
  await page.getByTestId(`driver-${orderCode2}-1`).selectOption({ label: 'Samir' });
  await expect(page.getByTestId(`reason-${orderCode2}-1`)).toBeVisible();
  await expect(page.getByTestId('dispatch-save')).toBeDisabled();
  await expect(page.getByText('Indiquez le motif de chaque changement de chauffeur.')).toBeVisible();
  await page.getByTestId(`reason-${orderCode2}-1`).fill('Nadia est malade');
  await page.getByTestId('dispatch-save').click();
  await expect(page.getByTestId('dispatch-message')).toContainText('Plan enregistré');
  await page.reload();
  await expect(page.getByTestId(`reason-${orderCode2}-1`)).toHaveValue('Nadia est malade');
  await logout(page);
});

test('the plant reads and plans the day; the partner too; no money', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.dispPlant.email);
  await goNav(page, 'dispatch-link');
  await page.goto(`/fr/dispatch?date=${DAY}`);
  await expect(page.getByTestId('dispatch-board')).toBeVisible();
  await expect(page.getByTestId('dispatch-save')).toBeVisible();
  await expect(page.getByTestId('driver-form')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(MONEY);
  await page.getByTestId('dispatch-propose').click();
  await page.getByTestId('dispatch-save').click();
  await expect(page.getByTestId('dispatch-message')).toContainText('Plan enregistré');
  await logout(page);

  await loginAndEnrol(page, 'fr', E2E_MD.dispPartner.email);
  await page.goto(`/fr/dispatch?date=${DAY}`);
  await expect(page.getByTestId('driver-form')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(MONEY);
});

test("office has no planning page and no link, but reads the day's rotations without any price (AC-INT-21)", async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.dispOffice.email);
  await expect(page.getByTestId('dispatch-link')).toHaveCount(0);
  expect((await page.goto(`/fr/dispatch?date=${DAY}`))?.status()).toBe(404);

  await page.goto('/fr');
  await goNav(page, 'dispatch-office-link');
  await page.goto(`/fr/dispatch/office?date=${DAY}`);
  await expect(page.getByTestId('office-dispatch')).toBeVisible();
  await expect(page.locator('[data-testid^="office-rotation-"]').first()).toContainText('m³');
  await expect(page.getByTestId('office-dispatch')).toContainText('Planifiée');
  await expect(page.locator('body')).not.toContainText(MONEY);
  await expect(page.getByTestId('dispatch-save')).toHaveCount(0);
  await expect(page.getByTestId('dispatch-board')).toHaveCount(0);

  // a day with nothing planned says so
  await page.goto('/fr/dispatch/office?date=2099-12-30');
  await expect(page.getByTestId('office-dispatch-none')).toBeVisible();

  // Arabic: right-to-left, codes and times left-to-right
  await page.goto(`/ar/dispatch/office?date=${DAY}`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('office-dispatch').locator('bdi[dir="ltr"]').first()).toBeVisible();
  await logout(page);
});

test('the plant and the owner have no office view', async ({ page }) => {
  await loginOwner(page, 'fr');
  expect((await page.goto(`/fr/dispatch/office?date=${DAY}`))?.status()).toBe(404);
  await expect(page.getByTestId('dispatch-office-link')).toHaveCount(0);
});
