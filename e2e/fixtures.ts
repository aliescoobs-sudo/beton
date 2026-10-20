import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import { expect, type Page } from '@playwright/test';

export const E2E_PORT = 3100;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_PASSWORD = 'correct-horse-battery-staple';
export const E2E_USERS = {
  fr: { email: 'e2e-fr@belgobeton.test', name: 'Utilisateur E2E' },
  ar: { email: 'e2e-ar@belgobeton.test', name: 'مستخدم تجريبي' },
} as const;
export const E2E_OWNER = { email: 'e2e-owner@belgobeton.test', name: 'Propriétaire E2E' } as const;
export const E2E_PLANT = { email: 'e2e-plant@belgobeton.test', name: 'Centrale E2E' } as const;
/** master-data specs: a partner per locale (edit) and an office user (read-only), each enrolled once by its spec. */
export const E2E_MD = {
  partnerFr: { email: 'e2e-md-partner-fr@belgobeton.test', name: 'Associé MD' },
  partnerAr: { email: 'e2e-md-partner-ar@belgobeton.test', name: 'شريك البيانات' },
  office: { email: 'e2e-md-office@belgobeton.test', name: 'Bureau MD' },
} as const;
export const E2E_CSP = { email: 'e2e-csp@belgobeton.test', name: 'CSP E2E' } as const;

/** TOTP from the key shown on the enrolment page, as an authenticator app would compute it. */
export async function totpFromDisplayedKey(displayed: string): Promise<string> {
  const raw = new TextDecoder().decode(base32.decode(displayed.replace(/\s+/g, '')));
  return createOTP(raw).totp();
}

/** Milliseconds until the next 30-second TOTP step (a code is accepted only once). */
export function msUntilNextStep(): number {
  return 30_000 - (Date.now() % 30_000) + 500;
}

export async function passwordStep(page: Page, locale: string, email: string) {
  await page.goto(`/${locale}/login`);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', E2E_PASSWORD);
  await page.click('button[type=submit]');
}

/** Password login of a not-yet-enrolled user, then enrolment in the browser. Returns the displayed key. */
export async function loginAndEnrol(page: Page, locale: string, email: string): Promise<string> {
  await passwordStep(page, locale, email);
  await expect(page).toHaveURL(`/${locale}/enrol`);
  await page.fill('input[name=password]', E2E_PASSWORD);
  await page.click('button[type=submit]');
  const key = (await page.getByTestId('totp-secret').textContent()) ?? '';
  await page.check('input[type=checkbox]');
  await page.fill('input[name=code]', await totpFromDisplayedKey(key));
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(`/${locale}`);
  return key;
}
