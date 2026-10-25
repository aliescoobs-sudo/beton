import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { testEnv } from '../tests/db-env';
import { deliveryScene } from '../tests/helpers/ledger-fixtures';
import { E2E_MD, loginAndEnrol, loginOwner, logout } from './fixtures';
import { checkScreen, watch } from './screen-check';

// operations O10 (AC-OPS-16, 17): the plant follows a rotation on a phone, one tap per step; the first tap is the load (BL).
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));

/** A day of its own with one order of 10 m³: the plan has two rotations (8 and 2 m³). */
const DAY = '2099-03-03';
let orderCode = '';
const MONEY = /MAD|DH|\d\s?\d{3},\d{2}/;

test.beforeAll(async () => {
  const owner = (await migrator.query<{ id: string }>(`select id from "user" where role = 'owner'`)).rows[0];
  const ownerId = owner?.id as string;
  // The scene brings a recette in force, so the first tap (the load) can be made.
  const scene = await deliveryScene(app, ownerId, `e2etr${randomUUID().replace(/-/g, '').slice(0, 8)}`, DAY);
  orderCode = (
    await migrator.query<{ code: string }>(`select code from sales_order where id = $1`, [scene.orderId])
  ).rows[0]?.code as string;
});

test('the owner plans the day, the plant follows the first rotation with one tap per step on a phone', async ({
  browser,
}) => {
  const owner = await browser.newPage();
  await loginOwner(owner, 'fr');
  await owner.goto(`/fr/dispatch?date=${DAY}`);
  await owner.getByTestId('dispatch-save').click();
  await expect(owner.getByTestId('dispatch-message')).toContainText('Plan enregistré');
  await owner.close();

  const context = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const page = await context.newPage();
  await loginAndEnrol(page, 'fr', E2E_MD.tripPlant.email);
  await page.goto(`/fr/trips?date=${DAY}`);
  const cards = page.locator('[data-testid^="trip-' + orderCode + '-"][data-next]');
  await expect(cards).toHaveCount(2);
  const card = cards.first();
  await expect(card).toHaveAttribute('data-next', 'loaded');

  const next = card.locator('[data-testid^="trip-next-"]');
  const box = await next.boundingBox();
  // one big button, as wide as the phone allows and easy to hit
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(52);
  expect(box?.width ?? 0).toBeGreaterThan(280);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);

  const steps = ['loaded', 'departed', 'arrived', 'unloading_started', 'unloading_finished', 'back'] as const;
  for (const [i, s] of steps.entries()) {
    await expect(card).toHaveAttribute('data-next', s);
    await card.locator('[data-testid^="trip-next-"]').click();
    if (i < steps.length - 1) await expect(card).toHaveAttribute('data-next', steps[i + 1] as string);
    else await expect(card).toHaveAttribute('data-next', 'done');
    await expect(card.locator(`[data-step="${s}"]`)).toHaveAttribute('data-done', 'true');
    if (s === 'loaded') await expect(card).toContainText(/BL-\d{4}-\d{5}/);
    if (s === 'unloading_started') await expect(card.getByTestId('trip-waiting')).toContainText('min');
  }
  await expect(card).toContainText('Rotation terminée');
  await expect(card.getByTestId('trip-times')).toContainText('Rotation (départ → retour)');
  await expect(page.locator('body')).not.toContainText(MONEY);
  await context.close();
});

test('the screen renders right-to-left in Arabic, phone and desktop, for the plant', async ({ page }) => {
  const problems = watch(page);
  await loginAndEnrol(page, 'ar', E2E_MD.tripPlantAr.email);
  await page.goto(`/ar/trips?date=${DAY}`);
  await expect(page.getByTestId('trips-list')).toBeVisible();
  await checkScreen(page, 'ar', 'trips');
  await page.goto('/ar/dispatch?date=2099-03-03');
  await checkScreen(page, 'ar', 'dispatch-saved');
  expect(problems).toEqual([]);
  await logout(page);
});

test('office has no trips page and no link', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.tripOffice.email);
  await expect(page.getByTestId('trips-link')).toHaveCount(0);
  expect((await page.goto(`/fr/trips?date=${DAY}`))?.status()).toBe(404);
});
