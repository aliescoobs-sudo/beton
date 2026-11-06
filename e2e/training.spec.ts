import { expect, test } from '@playwright/test';
import {
  E2E_BASE_URL,
  E2E_PASSWORD,
  E2E_TRAINING_ACCOUNTANT,
  E2E_TRAINING_URL,
  E2E_TRAINING_USER,
  totpFromDisplayedKey,
} from './fixtures';

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

test('R11-07: the phone push endpoints answer 404 in training, session or not, and the phone shows no push action', async ({
  request,
}) => {
  const origin = { origin: E2E_TRAINING_URL };
  expect((await request.get(`${E2E_TRAINING_URL}/api/field/push`)).status()).toBe(404);
  expect(
    (
      await request.post(`${E2E_TRAINING_URL}/api/field/push`, { headers: origin, data: { endpoint: 'x' } })
    ).status(),
  ).toBe(404);
  // on the normal server the same door exists: it asks for a phone session
  expect((await request.get(`${E2E_BASE_URL}/api/field/push`)).status()).toBe(401);
});

test('R11-07: the phone page of the training instance has no push subscription button', async ({ page }) => {
  await page.goto(`${E2E_TRAINING_URL}/ar/driver`);
  await expect(page.getByTestId('field-login')).toBeVisible();
  await expect(page.getByTestId('push-enable')).toHaveCount(0);
});

test('the same account has to enrol on a normal server', async ({ page }) => {
  await page.goto(`${E2E_BASE_URL}/fr/login`);
  await page.fill('input[name=email]', E2E_TRAINING_USER.email);
  await page.fill('input[name=password]', E2E_PASSWORD);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(`${E2E_BASE_URL}/fr/enrol`);
});

async function trainingSignIn(page: import('@playwright/test').Page, email: string) {
  await page.goto(`${E2E_TRAINING_URL}/fr/login`);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', E2E_PASSWORD);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(`${E2E_TRAINING_URL}/fr`);
}

test('R12-07: only owner, app_admin and accountant may reach the optional enrolment; anybody else is sent home', async ({
  page,
}) => {
  // an office-sales training account: no link in the banner, and the page itself refuses it
  await trainingSignIn(page, E2E_TRAINING_USER.email);
  await expect(page.getByTestId('training-enrol-link')).toHaveCount(0);
  await page.goto(`${E2E_TRAINING_URL}/fr/enrol`);
  await expect(page).toHaveURL(`${E2E_TRAINING_URL}/fr`);
  await expect(page.getByTestId('totp-qr')).toHaveCount(0);
});

test('R12-07: a training accountant enrols a real authenticator with a server-made QR code and the real code then works', async ({
  page,
}) => {
  await trainingSignIn(page, E2E_TRAINING_ACCOUNTANT.email);
  await page.getByTestId('training-enrol-link').click();
  await expect(page).toHaveURL(`${E2E_TRAINING_URL}/fr/enrol`);
  await page.fill('input[name=password]', E2E_PASSWORD);
  await page.click('button[type=submit]');
  // the QR code is made on our server (an inline image, nothing fetched from outside)
  await expect(page.getByTestId('totp-qr')).toBeVisible();
  expect(await page.getByTestId('totp-qr').getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
  const key = (await page.getByTestId('totp-secret').textContent()) ?? '';
  await page.check('input[type=checkbox]');
  await page.fill('input[name=code]', await totpFromDisplayedKey(key));
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(`${E2E_TRAINING_URL}/fr`);
  // the link is gone: the account now has a real authenticator
  await expect(page.getByTestId('training-enrol-link')).toHaveCount(0);
});

test('T5: a training account is not offered to switch on alerts (push is off there)', async ({ page }) => {
  await trainingSignIn(page, E2E_TRAINING_USER.email);
  await page.goto(`${E2E_TRAINING_URL}/fr/notifications`);
  await expect(page.getByRole('heading').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Activer les alertes/ })).toHaveCount(0);
  await expect(page.getByText(/Activer les alertes/)).toHaveCount(0);
});
