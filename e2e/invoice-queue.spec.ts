import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { markDelivered } from '../src/modules/operations';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { deliveryScene, newDelivery } from '../tests/helpers/ledger-fixtures';
import { checkScreen, watch } from './screen-check';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// integration I1.3: delivered, not invoiced. The owner and support see the amounts; office sees BL, date, product and m³
// and not one amount; every screen in fr and ar (AC-INT-05, AC-INT-24).
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));
const MONEY = /MAD|DH|\d\s?\d{3},\d{2}|780,00/;
let clientCode = '';
let blNo = '';
let typeCode = '';
let invoiceNumber = '';
let blNoAr = '';

test.beforeAll(async () => {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner').catch(() => null);
  const ownerId =
    owner?.id ??
    ((await migrator.query<{ id: string }>(`select id from "user" where role = 'owner'`)).rows[0]
      ?.id as string);
  const scene = await deliveryScene(app, ownerId, `e2eiq${randomUUID().replace(/-/g, '').slice(0, 8)}`);
  clientCode = (
    await migrator.query<{ code: string }>(`select code from client where id = $1`, [scene.clientId])
  ).rows[0]?.code as string;
  typeCode = (
    await migrator.query<{ code: string }>(`select code from concrete_type where id = $1`, [scene.typeId])
  ).rows[0]?.code as string;
  const load = await newDelivery(
    app,
    ownerId,
    `e2eiq${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    scene,
    8000,
  );
  blNo = load.blNo;
  const loadAr = await newDelivery(
    app,
    ownerId,
    `e2eiq${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    scene,
    3000,
  );
  blNoAr = loadAr.blNo;
  const plant = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'plant');
  await markDelivered(app, plant, { deliveryId: load.id }, { now: new Date() });
  await markDelivered(app, plant, { deliveryId: loadAr.id }, { now: new Date() });
});

test('the owner sees the client with the delivered load and what it comes to', async ({ page }) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'invoice-queue-link');
  await expect(page).toHaveURL('/fr/invoices/queue');
  const section = page.getByTestId(`queue-client-${clientCode}`);
  await expect(section).toBeVisible();
  await expect(page.getByTestId(`queue-row-${blNo}`)).toContainText('8 m³');
  await expect(page.getByTestId(`queue-row-${blNo}`)).toContainText('6 240,00');
  await expect(page.getByTestId(`queue-summary-${clientCode}`)).toContainText('10 296,00');
  await logout(page);
});

test('office sees the BL, the date, the product and the m³, and no amount at all', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.queueOffice.email);
  await goNav(page, 'invoice-queue-link');
  const row = page.getByTestId(`queue-row-${blNo}`);
  await expect(row).toContainText('8 m³');
  await expect(row).toContainText(typeCode);
  await expect(page.locator('body')).not.toContainText(MONEY);
  await expect(page.getByText('Montant HT')).toHaveCount(0);
  // Office ticks the BL and invoices it: it learns the number, and no amount.
  await page.getByTestId(`queue-pick-${blNo}`).check();
  await page.getByTestId(`queue-invoice-${clientCode}`).click();
  const saved = page.getByTestId(`queue-saved-${clientCode}`);
  await expect(saved).toContainText(/FA-\d{4}-\d{5}/);
  invoiceNumber = /FA-\d{4}-\d{5}/.exec((await saved.textContent()) ?? '')?.[0] as string;
  await expect(page.getByTestId(`queue-row-${blNo}`)).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(MONEY);
  // Search by number: office finds the BL, and not the invoice it just made (it reads no invoice).
  await page.getByTestId('search-box').fill(blNo);
  await page.getByTestId('search-box').press('Enter');
  await expect(page.getByTestId(`search-hit-${blNo}`)).toBeVisible();
  await page.getByTestId('search-input').fill(invoiceNumber);
  await page.getByTestId('search-submit').click();
  await expect(page.getByTestId('search-none')).toBeVisible();
  await expect(page.getByTestId(`search-hit-${invoiceNumber}`)).toHaveCount(0);
  await page.getByTestId('search-input').fill('Atlas Béton');
  await page.getByTestId('search-submit').click();
  await expect(page.getByTestId('search-error')).toBeVisible();
  await logout(page);
});

test('the owner opens that invoice: grouped by product, the BL listed, the totals', async ({ page }) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'invoices-link');
  await page.getByTestId(`invoice-open-${invoiceNumber}`).click();
  await expect(page.getByTestId(`invoice-group-${typeCode}`)).toContainText('8 m³');
  await expect(page.getByTestId('invoice-group-bls')).toContainText(blNo);
  await expect(page.getByTestId('invoice-totals')).toContainText('7 488,00');
  // Search by number finds the invoice by its prefix, with a link that opens it.
  await page.getByTestId('search-box').fill(invoiceNumber.slice(0, 9));
  await page.getByTestId('search-box').press('Enter');
  await expect(page.getByTestId(`search-hit-${invoiceNumber}`)).toBeVisible();
  await page.getByTestId(`search-hit-${invoiceNumber}`).getByRole('link').click();
  await expect(page.getByTestId('invoice-totals')).toContainText('7 488,00');
  // The neighbours of the invoice: its BL, a link that opens the delivery note, which points back to the invoice (AC-INT-17).
  await page.getByTestId(`related-link-${blNo}`).click();
  await expect(page).toHaveURL(/\/fr\/deliveries\//);
  await expect(page.getByTestId('related-invoice')).toContainText(invoiceNumber);
  await expect(page.getByTestId(`related-link-${invoiceNumber}`)).toBeVisible();
  await logout(page);
});

test('plant has no queue page and no link', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.queuePlant.email);
  await expect(page.getByTestId('invoice-queue-link')).toHaveCount(0);
  expect((await page.goto('/fr/invoices/queue'))?.status()).toBe(404);
});

test('Arabic: right-to-left, codes left-to-right, no CSP violation, phone and desktop', async ({ page }) => {
  const problems = watch(page);
  await loginAndEnrol(page, 'ar', E2E_MD.queueOfficeAr.email);
  await page.goto('/ar/invoices/queue');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId(`queue-row-${blNoAr}`)).toBeVisible();
  await checkScreen(page, 'ar', 'invoice-queue');
  expect(problems).toEqual([]);
});
