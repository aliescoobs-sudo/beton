import { expect, test, type Page } from '@playwright/test';
import { TWIN_URL } from '../playwright.twin.config';

// T20 (D251): with the twin seed in place, the owner opens the screens that must never be empty on the staging walk-through: the dashboard, the aging of clients and of
// suppliers, the cash forecast, the approvals inbox, the margins and the order flow. Every check looks at what the screen shows, not at a status alone.
test.describe.configure({ mode: 'serial' });

const email = () => process.env.TWIN_OWNER_EMAIL as string;
const password = () => process.env.TWIN_OWNER_PASSWORD as string;

async function signIn(page: Page) {
  await page.goto(`${TWIN_URL}/fr/login`);
  await page.fill('input[name=email]', email());
  await page.fill('input[name=password]', password());
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(`${TWIN_URL}/fr`);
}

/** Opens a page and checks it loaded (not a 404, not the sign-in) and that the training banner is on it. */
async function open(page: Page, path: string) {
  const response = await page.goto(`${TWIN_URL}${path}`);
  expect(response?.status(), path).toBeLessThan(400);
  await expect(page).toHaveURL(new RegExp(`${path.split('?')[0]}`));
  await expect(page.getByTestId('training-banner')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test('the owner dashboard has data: the cash cards, the alerts of the day, no empty-state sentence', async ({
  page,
}) => {
  await expect(page.getByTestId('dashboard-empty')).toHaveCount(0);
  await expect(page.getByTestId('owner-today')).toBeVisible();
  await expect(page.getByTestId('five-seconds')).toBeVisible();
  expect(await page.locator('[data-testid^="cash-"]').count()).toBeGreaterThan(0);
});

test('the aging screen lists clients with balances, and the suppliers too', async ({ page }) => {
  await open(page, '/fr/aging');
  const clients = page.getByTestId('aging-table-client');
  await expect(clients).toBeVisible();
  expect(await clients.locator('[data-testid^="aging-row-"]').count()).toBeGreaterThanOrEqual(15);
  await expect(page.getByTestId('aging-total-client')).toBeVisible();
  await expect(page.getByTestId('aging-table-supplier')).toBeVisible();
  expect(
    await page.getByTestId('aging-table-supplier').locator('[data-testid^="aging-row-"]').count(),
  ).toBeGreaterThanOrEqual(5);
});

test('the cash forecast shows cheques and LCN in and out, and the loan instalments', async ({ page }) => {
  await open(page, '/fr/forecast');
  await expect(page.getByTestId('forecast-table')).toBeVisible();
  const items = page.getByTestId('forecast-items');
  await expect(items).toBeVisible();
  expect(await items.locator('tbody tr').count()).toBeGreaterThanOrEqual(10);
});

test('the approvals inbox holds the outgoing payment above the upper limit', async ({ page }) => {
  await open(page, '/fr/approvals');
  await expect(page.getByTestId('approvals')).toBeVisible();
  await expect(page.getByTestId('approvals-payments')).toBeVisible();
  expect(await page.locator('[data-testid^="approval-payment-"]').count()).toBeGreaterThanOrEqual(1);
});

test('the margins screen has the BLs of September to November, by month, and says the inputs are assumed', async ({
  page,
}) => {
  await open(page, '/fr/margins?from=2026-09-01&to=2026-11-15');
  await expect(page.getByTestId('margins-summary')).toBeVisible();
  expect(await page.locator('[data-testid^="margins-row-"]').count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('margins-total')).toBeVisible();
  await expect(page.getByTestId('margins-assumed')).toBeVisible();
});

test('the order flow lists the orders with their steps, and the orders screen lists them too', async ({
  page,
}) => {
  await open(page, '/fr/orders/chain');
  await expect(page.getByTestId('chain-none')).toHaveCount(0);
  const chain = page.getByTestId('chain-list');
  await expect(chain).toBeVisible();
  expect(await chain.locator('tbody tr').count()).toBeGreaterThanOrEqual(20);
  await open(page, '/fr/orders');
  await expect(page.getByTestId('orders-none')).toHaveCount(0);
  expect(await page.getByTestId('orders-list').locator('tbody tr').count()).toBeGreaterThanOrEqual(20);
});
