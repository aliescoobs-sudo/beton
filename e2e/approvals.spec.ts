import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { clientWithLoads, deliveryScene, orderMaster } from '../tests/helpers/ledger-fixtures';
import { loginOwner } from './fixtures';

// R3 (AC-PROD-17, 19): the owner's approvals inbox. Cards say what one tap writes; a decision removes its card.
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));
const codes = { price: '', held: '' };

test.beforeAll(async () => {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const marker = `e2eap${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const scene = await deliveryScene(app, owner.id, marker);
  const master = await orderMaster(app, owner.id, marker);
  const c = await clientWithLoads(app, owner.id, master, scene, [[], []]);
  codes.price = c.orders[0]!.code;
  codes.held = c.orders[1]!.code;
  await withRlsContext(migrator, { userId: owner.id, role: 'owner', requestId: marker }, async (tx) => {
    await tx.query(
      `insert into order_price_status (order_id, provisional_unit_price_centimes, created_by) values ($1, 78000, $2)`,
      [c.orders[0]!.id, owner.id],
    );
    await tx.query(`insert into order_hold (order_id, reason, created_by) values ($1, 'credit_limit', $2)`, [
      c.orders[1]!.id,
      owner.id,
    ]);
  });
});

test('the owner sees both cards, confirms the price, releases the held order (French)', async ({ page }) => {
  await loginOwner(page, 'fr');
  await page.goto('/fr/approvals');
  const price = page.getByTestId(`approval-price-${codes.price}`);
  const held = page.getByTestId(`approval-credit-${codes.held}`);
  await expect(price).toBeVisible();
  await expect(held).toBeVisible();
  await expect(price).toContainText('Prix provisoire');
  await expect(held).toContainText('Limite de crédit dépassée');

  await page.getByTestId(`approve-price-${codes.price}`).click();
  await expect(page.getByTestId('approvals-message')).toHaveText('Décision enregistrée.');
  await expect(page.getByTestId(`approval-price-${codes.price}`)).toHaveCount(0);

  await page.getByTestId(`approve-credit-${codes.held}`).click();
  await expect(page.getByTestId(`approval-credit-${codes.held}`)).toHaveCount(0);
});

test('the inbox renders right-to-left in Arabic without overflow at phone width', async ({ page }) => {
  await loginOwner(page, 'ar');
  await page.goto('/ar/approvals');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('موافقات في الانتظار');
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
