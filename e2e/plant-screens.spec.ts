import { expect, test } from '@playwright/test';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { testEnv } from '../tests/db-env';
import { E2E_MD, loginAndEnrol, loginOwner, logout } from './fixtures';

// C4.4: the screens added in C3 that only integration tests covered: the plant picker on the order and purchase forms, the receipt
// states with the variance flag, and the reference price per plant. Two plants are active for this file only; they are archived
// again in afterAll (also when a test fails) so the plant rule never reaches another spec.
test.describe.configure({ mode: 'serial' });

const migrator = new pg.Pool({ connectionString: testEnv(E2E_DATABASE).DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: testEnv(E2E_DATABASE).DATABASE_URL_APP, max: 1 });
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
const plants: { id: string; code: string; name: string }[] = [];
let purchaseCode = '';

test.beforeAll(async () => {
  const owner = (await migrator.query<{ id: string }>(`select id from "user" where role = 'owner' limit 1`))
    .rows[0]!.id;
  const asOwner = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
    withRlsContext(app, { userId: owner, role: 'owner', requestId: 'plant-screens' }, fn);
  for (const letter of ['A', 'B']) {
    const code = letters(6);
    const name = `Ecran${letter} ${code}`;
    const id = (
      await asOwner((tx) =>
        tx.query<{ id: string }>(
          `insert into plant (id, code, name, created_by) values (gen_random_uuid(), $1, $2, $3) returning id`,
          [code, name, owner],
        ),
      )
    ).rows[0]!.id;
    plants.push({ id, code, name });
  }
});
test.afterAll(async () => {
  const owner = (await migrator.query<{ id: string }>(`select id from "user" where role = 'owner' limit 1`))
    .rows[0]!.id;
  await withRlsContext(app, { userId: owner, role: 'owner', requestId: 'plant-screens' }, (tx) =>
    tx.query(`update plant set status = 'archived' where id = any($1::uuid[])`, [plants.map((p) => p.id)]),
  );
  await Promise.all([migrator.end(), app.end()]);
});

test('the order and purchase forms ask for the plant once two are active, and the row takes it', async ({
  page,
}) => {
  const [a, b] = plants as [(typeof plants)[number], (typeof plants)[number]];
  await loginAndEnrol(page, 'fr', E2E_MD.psOffice.email);

  await page.goto('/fr/orders/new');
  await expect(page.getByTestId('order-plant')).toBeVisible();
  await expect(page.getByTestId('order-plant').locator('option')).toHaveCount(3); // the prompt and the two plants
  await page.getByTestId('order-client-search').fill('Atlas');
  await page.getByTestId('order-client').selectOption({ index: 1 });
  await page.getByTestId('order-type').selectOption({ label: 'B25 · Béton B25' });
  await page.getByTestId('order-volume').fill('4');
  await page.getByTestId('order-preset').selectOption('advance50');
  await page.getByTestId('order-save').click();
  await expect(page.getByTestId('order-saved')).toHaveCount(0); // no plant chosen: nothing is saved
  await page.getByTestId('order-plant').selectOption({ label: a.name });
  await page.getByTestId('order-save').click();
  await expect(page.getByTestId('order-saved')).toContainText('CMD-');
  const code = /CMD-\d{4}-\d{5}/.exec((await page.getByTestId('order-saved').textContent()) ?? '')![0];
  expect(
    (await migrator.query(`select plant_id from sales_order where code = $1`, [code])).rows[0]?.plant_id,
  ).toBe(a.id);
  await expect(page.locator('body')).not.toContainText(/MAD|DH/);

  await page.goto('/fr/purchases/new');
  await expect(page.getByTestId('purchase-plant')).toBeVisible();
  await page.getByTestId('purchase-supplier').selectOption({ index: 1 });
  await page.getByTestId('purchase-line-component').selectOption({ label: 'Ciment' });
  await page.getByTestId('purchase-line-unit').selectOption({ label: 't' });
  await page.getByTestId('purchase-line-qty').fill('10');
  await page.getByTestId('purchase-line-price').fill('1 450,00');
  await page.getByTestId('purchase-save').click();
  await expect(page.getByTestId('purchase-saved')).toHaveCount(0);
  await page.getByTestId('purchase-plant').selectOption({ label: b.name });
  await page.getByTestId('purchase-save').click();
  await expect(page.getByTestId('purchase-saved')).toContainText('ACH-');
  purchaseCode = /ACH-\d{4}-\d{5}/.exec((await page.getByTestId('purchase-saved').textContent()) ?? '')![0];
  expect(
    (await migrator.query(`select plant_id from purchase where code = $1`, [purchaseCode])).rows[0]?.plant_id,
  ).toBe(b.id);
});

test('the plant counts the arrival; the office documents less; both states and the gap show', async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.psPlant.email);
  await page.goto('/fr/receipts');
  await page.getByTestId(`confirm-arrival-${purchaseCode}`).click();
  await page.locator(`[data-testid^="arrived-${purchaseCode}-"]`).fill('6');
  await page.locator(`[data-testid^="rejected-${purchaseCode}-"]`).fill('1');
  await page.locator(`[data-testid^="available-${purchaseCode}-"]`).check();
  await page.getByTestId(`arrival-submit-${purchaseCode}`).click();
  const state = page.getByTestId(`receipt-state-${purchaseCode}`);
  await expect(state).toHaveAttribute('data-state', 'available');
  await expect(state).toContainText('Quantité refusée');
  await expect(state).toContainText('Livraison partielle');
  await expect(state).toContainText('utilisable');
  await expect(page.locator('body')).not.toContainText(/MAD|DH|\d\s?\d{3},\d{2}/);
  await logout(page);

  // the office documents 3 t where the plant found 5 t usable: a 40 % gap, far above the threshold
  await loginOwner(page, 'fr');
  await page.goto('/fr/receipts');
  await page.getByTestId(`receive-partial-${purchaseCode}`).click();
  await page.locator(`[data-testid^="receive-qty-${purchaseCode}-"]`).fill('3');
  await page.getByTestId(`receive-submit-${purchaseCode}`).click();
  await expect(page.getByTestId(`receipt-effects-${purchaseCode}`)).toBeVisible();
  await page.goto('/fr/receipts');
  const done = page.getByTestId(`receipt-state-${purchaseCode}`);
  await expect(done).toHaveAttribute('data-state', 'documented');
  await expect(page.getByTestId(`variance-${purchaseCode}`)).toContainText('Écart au-dessus du seuil');
  await expect(page.getByTestId(`variance-line-${purchaseCode}`)).toContainText(/[-−]2/);
  await expect(page.getByTestId(`variance-line-${purchaseCode}`)).toContainText('40,00 %');
});

test('the reference price can be set for one plant and each version shows its plant', async ({ page }) => {
  const [a, b] = plants as [(typeof plants)[number], (typeof plants)[number]];
  await loginOwner(page, 'fr');
  await page.goto('/fr/master-data/selling-prices');
  const form = page.getByTestId('sell-new-B25');
  for (const [plant, price] of [
    [a, '905,00'],
    [b, '915,00'],
  ] as const) {
    await form.getByTestId('sell-plant-select-B25').selectOption({ label: plant.name });
    await form.locator('input[name=price]').fill(price);
    await form.locator('input[name=effectiveFrom]').fill('2300-01-01');
    await form.locator('button[type=submit]').click();
    await expect(page.getByTestId('sell-B25')).toContainText(`${price} MAD HT / m³`);
  }
  const section = page.getByTestId('sell-B25');
  await expect(section).toContainText(a.name);
  await expect(section).toContainText(b.name);
  // the same date again for the same plant is refused, the other plant's scope is not affected
  await form.getByTestId('sell-plant-select-B25').selectOption({ label: a.name });
  await form.locator('input[name=price]').fill('906');
  await form.locator('input[name=effectiveFrom]').fill('2300-01-01');
  await form.locator('button[type=submit]').click();
  await expect(form.getByTestId('sell-message')).toHaveText(
    'La date doit être postérieure à celle du dernier prix.',
  );
});
