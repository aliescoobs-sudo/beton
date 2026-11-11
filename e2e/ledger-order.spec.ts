import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { testEnv } from '../tests/db-env';
import { E2E_MD, goNav, loginAndEnrol, loginOwner } from './fixtures';

// ledger L4: order entry. Office enters blind (DECISIONS 81): no price, no amount, only the code it saved.
test.describe.configure({ mode: 'serial' });

const migrator = new pg.Pool({ connectionString: testEnv(E2E_DATABASE).DATABASE_URL_MIGRATOR, max: 1 });
test.afterAll(() => migrator.end());

const lastOrder = async () =>
  (
    await migrator.query<{ code: string; total_ttc_centimes: string; items: string[] }>(
      `select o.code, o.total_ttc_centimes,
              array(select amount_centimes::text from payment_plan_item i where i.order_id = o.id order by seq) as items
         from sales_order o order by o.created_at desc limit 1`,
    )
  ).rows[0];

test('office enters orders blind: AC-LED-10 timing, a custom plan, a refused plan', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.orderOffice.email);
  await goNav(page, 'orders-new-link');
  await expect(page).toHaveURL('/fr/orders/new');
  await expect(page.getByTestId('order-preview-button')).toHaveCount(0);

  const started = Date.now();
  await page.getByTestId('order-client-search').fill('Atlas');
  await page.getByTestId('order-client').selectOption({ index: 1 });
  await page.getByTestId('order-type').selectOption({ label: 'B25 · Béton B25' });
  await page.getByTestId('order-volume').fill('10');
  await page.getByTestId('order-preset').selectOption('advance50');
  await page.getByTestId('order-save').click();
  await expect(page.getByTestId('order-saved')).toContainText('CMD-');
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(120_000);

  // Blind: nothing monetary on the page, before or after saving.
  await expect(page.locator('body')).not.toContainText(/MAD|DH|prix HT/);
  // Atlas has a 820,00 override on B25: 10 m³ = 8 200,00 HT + 1 640,00 VAT = 9 840,00 TTC, split 50 / 50.
  const order = await lastOrder();
  expect(order?.total_ttc_centimes).toBe('984000');
  expect(order?.items).toEqual(['492000', '492000']);

  if (process.env.ENTRY_TIMING) {
    mkdirSync('docs/pilot', { recursive: true });
    writeFileSync(
      'docs/pilot/entry-timing.md',
      `# Order entry timing (AC-LED-10)\n\nMeasured by \`e2e/ledger-order.spec.ts\` (office user, one client found by search, type, volume, a 2-item plan from the\n"50 % d'avance + 50 % à la livraison" preset, save; no AI): **${(elapsed / 1000).toFixed(1)} s** of scripted entry (no human think time) against the 120 s target.\nRe-measure with \`ENTRY_TIMING=1 pnpm exec playwright test e2e/ledger-order.spec.ts\`.\n`,
    );
  }

  // Custom plan (30 % / 70 %).
  await page.goto('/fr/orders/new');
  await page.getByTestId('order-client-search').fill('Atlas');
  await page.getByTestId('order-client').selectOption({ index: 1 });
  await page.getByTestId('order-type').selectOption({ label: 'B25 · Béton B25' });
  await page.getByTestId('order-volume').fill('7,5');
  await page.getByTestId('order-preset').selectOption('custom');
  const values = page.getByTestId('order-row-value');
  await values.nth(0).fill('30');
  await expect(page.getByTestId('order-percent-sum')).toContainText('80');
  await values.nth(1).fill('70');
  await expect(page.getByTestId('order-percent-sum')).toContainText('100');
  await page.getByTestId('order-save').click();
  await expect(page.getByTestId('order-saved')).toContainText('CMD-');
  // 7,5 m³ × 820,00 = 6 150,00 HT; TTC 7 380,00; 30 % = 2 214,00 and the last item takes the rest.
  expect((await lastOrder())?.items).toEqual(['221400', '516600']);

  // A plan that is not 100 % is refused by the server, nothing is saved.
  await page.goto('/fr/orders/new');
  const before = (await lastOrder())?.code;
  await page.getByTestId('order-client-search').fill('Atlas');
  await page.getByTestId('order-client').selectOption({ index: 1 });
  await page.getByTestId('order-type').selectOption({ label: 'B25 · Béton B25' });
  await page.getByTestId('order-volume').fill('5');
  await page.getByTestId('order-preset').selectOption('custom');
  await page.getByTestId('order-row-value').nth(0).fill('30');
  await page.getByTestId('order-row-value').nth(1).fill('30');
  await page.getByTestId('order-save').click();
  await expect(page.getByTestId('order-message')).toContainText("L'échéancier ne correspond pas");
  expect((await lastOrder())?.code).toBe(before);
});

test('the owner previews the amounts computed by the server', async ({ page }) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'orders-new-link');
  await page.getByTestId('order-client-search').fill('Atlas');
  await page.getByTestId('order-client').selectOption({ index: 1 });
  await page.getByTestId('order-type').selectOption({ label: 'B25 · Béton B25' });
  await page.getByTestId('order-volume').fill('10');
  await page.getByTestId('order-preview-button').click();
  await expect(page.getByTestId('preview-ht')).toContainText('8 200,00');
  await expect(page.getByTestId('preview-ttc')).toContainText('9 840,00');
});

test('the plant has no order entry (404, no link); Arabic renders right-to-left', async ({
  page,
  browser,
}) => {
  for (const user of [E2E_MD.orderPlant]) {
    const other = await browser.newPage();
    await loginAndEnrol(other, 'fr', user.email);
    await expect(other.getByTestId('orders-new-link')).toHaveCount(0);
    expect((await other.goto('/fr/orders/new'))?.status(), user.email).toBe(404);
    await other.close();
  }
  await loginAndEnrol(page, 'ar', E2E_MD.orderOfficeAr.email);
  await goNav(page, 'orders-new-link');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('طلبية جديدة');
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
