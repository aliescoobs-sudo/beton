import { expect, test } from '@playwright/test';
import { E2E_BASE_URL, E2E_PASSWORD, E2E_TRAINING_URL, E2E_TRAINING_USER } from './fixtures';

// T1: the training instance (a second server with TRAINING_MODE=true on the same database). The banner is on every page in the user's
// language, a training account signs in with a password alone, and none of this exists on the other server.
test.describe.configure({ mode: 'serial' });

test('the banner is on the sign-in page in French and in Arabic, and not on a normal server', async ({
  page,
}) => {
  await page.goto(`${E2E_TRAINING_URL}/fr/login`);
  await expect(page.getByTestId('training-banner')).toHaveText('Version de formation — données fictives');
  await page.goto(`${E2E_TRAINING_URL}/ar/login`);
  await expect(page.getByTestId('training-banner')).toHaveText('نسخة تدريب — معطيات وهمية');
  await page.goto(`${E2E_BASE_URL}/fr/login`);
  await expect(page.getByTestId('training-banner')).toHaveCount(0);
});

test('a training account signs in with its password alone and the banner stays on every page', async ({
  page,
}) => {
  await page.goto(`${E2E_TRAINING_URL}/fr/login`);
  await page.fill('input[name=email]', E2E_TRAINING_USER.email);
  await page.fill('input[name=password]', E2E_PASSWORD);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(`${E2E_TRAINING_URL}/fr`);
  await expect(page.getByTestId('training-banner')).toBeVisible();
  await page.goto(`${E2E_TRAINING_URL}/fr/orders/new`);
  await expect(page.getByTestId('training-banner')).toBeVisible();
  // RBAC is the application's own: office sales has no page for the money screens
  expect((await page.goto(`${E2E_TRAINING_URL}/fr/cash`))?.status()).toBe(404);
  // outbound push is off
  expect((await page.request.get(`${E2E_TRAINING_URL}/api/push`)).status()).toBe(404);
});

test('the same account has to enrol on a normal server', async ({ page }) => {
  await page.goto(`${E2E_BASE_URL}/fr/login`);
  await page.fill('input[name=email]', E2E_TRAINING_USER.email);
  await page.fill('input[name=password]', E2E_PASSWORD);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(`${E2E_BASE_URL}/fr/enrol`);
});
