import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { testEnv } from '../tests/db-env';
import {
  insertOrder,
  insertPurchase,
  orderMaster,
  purchaseMaster,
  type PurchaseMaster,
} from '../tests/helpers/ledger-fixtures';
import { E2E_MD, goNav, loginAndEnrol, loginOwner } from './fixtures';
import { checkScreen, watch } from './screen-check';

// operations O12 (AC-OPS-20, 21): the supplier's lead time, the days of cover per component, the draft purchase for the
// owner; the plant sees the cover and the order-by date but no supplier, price or draft.
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));

const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
let pm: PurchaseMaster;
let componentName = '';
const MONEY = /MAD|DH|\d\s?\d{3},\d{2}/;

test.beforeAll(async () => {
  const owner = (await migrator.query<{ id: string }>(`select id from "user" where role = 'owner'`)).rows[0];
  const ownerId = owner?.id as string;
  pm = await purchaseMaster(app, ownerId, `e2ero${suffix}`);
  componentName = `ps${`e2ero${suffix}`}`;
  const master = await orderMaster(app, ownerId, `e2ero${suffix}`);
  const today = (await migrator.query<{ d: string }>(`select to_char(current_date, 'YYYY-MM-DD') as d`))
    .rows[0]?.d as string;
  await withRlsContext(app, { userId: ownerId, role: 'owner', requestId: 'e2e-reorder' }, async (tx) => {
    const recette = await tx.query<{ id: string }>(
      `insert into recette (id, concrete_type_id, version, effective_from, created_by) values (gen_random_uuid(), $1, 1, '2000-01-01', $2) returning id`,
      [master.typeId, ownerId],
    );
    await tx.query(
      `insert into recette_line (id, recette_id, component_id, qty_per_m3) values (gen_random_uuid(), $1, $2, 2000000)`,
      [recette.rows[0]?.id, pm.componentId],
    );
    await insertPurchase(tx, ownerId, pm);
    // two orders of 10 m³ (20 t each) due on the next two days against 30 t expected
    for (const plus of [0, 1]) {
      const day = (
        await migrator.query<{ d: string }>(`select to_char($1::date + $2::int, 'YYYY-MM-DD') as d`, [
          today,
          plus,
        ])
      ).rows[0]?.d as string;
      await insertOrder(tx, ownerId, master, day);
    }
  });
});

test('the owner gives a supplier a lead time, and sees the days of cover and the draft purchase', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'suppliers-link');
  await page.getByTestId('supplier-add').click();
  const form = page.getByTestId('supplier-new');
  const name = `Délai ${suffix}`;
  await form.locator('input[name=name]').fill(name);
  await form.locator('select[name=category]').selectOption('cement');
  await form.getByTestId('supplier-lead-time').fill('4');
  await form.locator('button[type=submit]').click();
  await expect(page.getByTestId('supplier-message')).toHaveText('Enregistré.');
  await expect(page.getByTestId(`supplier-${name}`)).toContainText('4');

  // the usual supplier of the component gets a lead time of 3 days
  const owner = (await migrator.query<{ id: string }>(`select id from "user" where role = 'owner'`)).rows[0];
  await withRlsContext(app, { userId: owner?.id as string, role: 'owner', requestId: 'e2e-reorder' }, (tx) =>
    tx.query(`update supplier set lead_time_days = 3 where id = $1`, [pm.supplierId]),
  );
  await page.goto('/fr/stock/projection');
  const row = page.getByTestId(`cover-${pm.componentId}`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-needs-order', 'true');
  await expect(row).toContainText(/À commander|Déjà en retard/);
  await expect(page.getByTestId(`draft-${pm.componentId}`)).toContainText('chez');
  await expect(page.getByTestId(`draft-${pm.componentId}`)).toContainText('Brouillon');
  await expect(page.getByTestId(`draft-${pm.componentId}`)).toContainText(componentName);
});

test('the plant sees the cover and when to order, but no supplier, price or draft; Arabic renders', async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.rdPlant.email);
  await page.goto('/fr/stock/projection');
  const row = page.getByTestId(`cover-${pm.componentId}`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-needs-order', 'true');
  await expect(page.getByTestId(`draft-${pm.componentId}`)).toHaveCount(0);
  await expect(row).toContainText('réservé au propriétaire');
  await expect(page.locator('body')).not.toContainText(MONEY);
  await expect(page.locator('body')).not.toContainText('FRN-');
});

test('the projection renders right-to-left in Arabic with the cover table', async ({ page }) => {
  const problems = watch(page);
  await loginOwner(page, 'ar');
  await page.goto('/ar/stock/projection');
  await expect(page.getByTestId('cover')).toBeVisible();
  await checkScreen(page, 'ar', 'stock-projection');
  expect(problems).toEqual([]);
});
