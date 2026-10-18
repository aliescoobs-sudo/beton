import { expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { testEnv } from '../tests/db-env';
import { E2E_PASSWORD, E2E_USERS, msUntilNextStep, totpFromDisplayedKey } from './fixtures';

const migrator = new pg.Pool({ connectionString: testEnv(E2E_DATABASE).DATABASE_URL_MIGRATOR, max: 1 });
test.afterAll(() => migrator.end());

async function passwordStep(page: Page, locale: string, email: string) {
  await page.goto(`/${locale}/login`);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', E2E_PASSWORD);
  await page.click('button[type=submit]');
}

for (const locale of ['fr', 'ar'] as const) {
  const user = E2E_USERS[locale];

  test(`${locale}: login → enrolment → logout → TOTP login → step-up → recovery login → re-enrolment`, async ({
    page,
  }) => {
    // Anonymous visitors are sent to login; the page direction follows the locale.
    await page.goto(`/${locale}`);
    await expect(page).toHaveURL(`/${locale}/login`);
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');

    // Password login of a user without 2FA: only enrolment is reachable.
    await passwordStep(page, locale, user.email);
    await expect(page).toHaveURL(`/${locale}/enrol`);
    await page.goto(`/${locale}`);
    await expect(page).toHaveURL(`/${locale}/enrol`);

    // Enrolment: confirm password, read key and recovery codes (shown once), confirm a first code.
    await page.fill('input[name=password]', E2E_PASSWORD);
    await page.click('button[type=submit]');
    await expect(page.getByTestId('totp-qr')).toBeVisible();
    expect(await page.getByTestId('totp-qr').getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    const key = (await page.getByTestId('totp-secret').textContent()) ?? '';
    await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
    await page.check('input[type=checkbox]');
    await page.fill('input[name=code]', await totpFromDisplayedKey(key));
    await page.click('button[type=submit]');
    await expect(page).toHaveURL(`/${locale}`);
    await expect(page.getByTestId('signed-in-as')).toContainText(user.name);

    // Logout ends the session server-side: the home page is no longer reachable.
    await page.locator('button[type=button]').last().click();
    await expect(page).toHaveURL(`/${locale}/login`);
    await page.goto(`/${locale}`);
    await expect(page).toHaveURL(`/${locale}/login`);

    // Login with password + TOTP (next 30 s step: a code is accepted only once).
    await passwordStep(page, locale, user.email);
    await expect(page.locator('input[name=code]')).toBeVisible();
    await page.waitForTimeout(msUntilNextStep());
    await page.fill('input[name=code]', await totpFromDisplayedKey(key));
    await page.click('button[type=submit]');
    await expect(page).toHaveURL(`/${locale}`);

    // Step-up: make this session's last second factor 11 minutes old (the only test shortcut), then a sensitive action.
    await migrator.query(
      `update session set "twoFactorAt" = now() - interval '11 minutes'
        where "userId" = (select id from "user" where email = $1)`,
      [user.email],
    );
    await page.goto(`/${locale}/security`);
    await page.fill('input[name=password]', E2E_PASSWORD);
    await page.click('button[type=submit]');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(msUntilNextStep());
    await dialog.locator('input[name=code]').fill(await totpFromDisplayedKey(key));
    await dialog.locator('button[type=submit]').click();
    const fresh = page.getByTestId('recovery-codes').locator('li');
    await expect(fresh).toHaveCount(10);
    const recoveryCode = (await fresh.first().textContent()) ?? '';

    // Login with a recovery code from the new set.
    await page.goto(`/${locale}`);
    await page.locator('button[type=button]').last().click();
    await expect(page).toHaveURL(`/${locale}/login`);
    await passwordStep(page, locale, user.email);
    await page.locator('form button[type=button]').click(); // switch to recovery code
    await page.fill('input[name=code]', recoveryCode);
    await page.click('button[type=submit]');
    await expect(page).toHaveURL(`/${locale}`);

    // After a recovery-code login: re-enrol a new authenticator before any sensitive action (DECISIONS 72).
    await expect(page.getByTestId('reenrol-banner')).toBeVisible();
    await page.getByTestId('reenrol-banner').locator('a').click();
    await expect(page).toHaveURL(`/${locale}/security`);
    await page.fill('input[name=password]', E2E_PASSWORD);
    await page.click('button[type=submit]');
    const newKey = (await page.getByTestId('totp-secret').textContent()) ?? '';
    expect(newKey).not.toBe(key);
    await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
    await page.check('input[type=checkbox]');
    await page.fill('input[name=code]', await totpFromDisplayedKey(newKey));
    await page.click('button[type=submit]');
    await expect(page).toHaveURL(`/${locale}`);
    await expect(page.getByTestId('reenrol-banner')).toHaveCount(0);
  });
}
