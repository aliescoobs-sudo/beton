import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { E2E_MD, loginAndEnrol } from './fixtures';

// T19 (D245, D247): the two office roles read the money of THEIR side only, on the new screens. fr and ar, desktop and phone.
// Screenshots (docs/ui/screenshots) only with UI_SCREENSHOTS=1. Fictitious data only.
test.describe.configure({ mode: 'serial' });
const SHOTS = Boolean(process.env.UI_SCREENSHOTS);
const OUT = 'docs/ui/screenshots';
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 375, height: 800 };
const noSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}
async function visit(page: Page, locale: string, path: string, name: string) {
  await page.setViewportSize(DESKTOP);
  await page.goto(`/${locale}${path}`);
  await page.waitForLoadState('networkidle');
  if (locale === 'ar') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await shot(page, `${name}-${locale}`);
  await page.setViewportSize(PHONE);
  expect(await noSideways(page), `${path} ${locale} on a phone`).toBe(true);
  await shot(page, `${name}-${locale}-phone`);
  await page.setViewportSize(DESKTOP);
}
const gone = async (page: Page, locale: string, paths: string[]) => {
  for (const p of paths) expect((await page.goto(`/${locale}${p}`))?.status(), p).toBe(404);
};

for (const [locale, key] of [
  ['fr', 't19SalesFr'],
  ['ar', 't19SalesAr'],
] as const) {
  test(`the Responsable (office_sales), ${locale}: clients, reminders, validation only; nothing of the other side`, async ({
    page,
  }) => {
    await loginAndEnrol(page, locale, E2E_MD[key].email);
    await visit(page, locale, '/statements', 'office-sales-accounts');
    await expect(page.getByTestId('accounts-client')).toBeVisible();
    await expect(page.getByTestId('accounts-supplier')).toHaveCount(0);
    await visit(page, locale, '/reminders', 'office-sales-reminders');
    await expect(page.getByTestId('reminders-table')).toBeVisible();
    if (locale === 'fr') {
      await page.getByTestId('reminder-note').first().fill('Appel du lundi, promet un chèque');
      await page.getByTestId('reminder-log').first().click();
      await expect(page.getByTestId('reminder-message').first()).toContainText('Relance notée');
      await page.reload();
      await expect(page.getByTestId('reminders-log')).toContainText('Appel du lundi');
    }
    await visit(page, locale, '/instruments', 'office-sales-instruments');
    await visit(page, locale, '/charges', 'office-sales-charges');
    await expect(page.getByTestId('charge-form')).toHaveCount(0); // it validates, it does not record
    await visit(page, locale, '/payment-requests', 'office-sales-payment-requests');
    await expect(page.getByTestId('payment-request-form')).toHaveCount(0);
    // not hers: costs, margins, cash, bank accounts, the finance pages, the supplier statements
    await gone(page, locale, [
      '/margins',
      '/cash',
      '/accounts',
      '/finance',
      '/costs',
      '/fuel-check',
      '/statements/supplier/00000000-0000-0000-0000-000000000000',
    ]);
  });
}

for (const [locale, key] of [
  ['fr', 't19PurchFr'],
  ['ar', 't19PurchAr'],
] as const) {
  test(`the Assistante (office_purchases), ${locale}: suppliers, cash day, charges, payments to validate; nothing of the client side`, async ({
    page,
  }) => {
    await loginAndEnrol(page, locale, E2E_MD[key].email);
    await visit(page, locale, '/statements', 'office-purchases-accounts');
    await expect(page.getByTestId('accounts-supplier')).toBeVisible();
    await expect(page.getByTestId('accounts-client')).toHaveCount(0);
    await visit(page, locale, '/cash', 'office-purchases-cash');
    await expect(page.getByTestId('cash-day')).toBeVisible();
    await expect(page.getByTestId('cash-incoming')).toHaveCount(0); // the client side of the position is not hers
    await visit(page, locale, '/charges', 'office-purchases-charges');
    if (locale === 'fr') {
      const name = `Loyer E2E ${Date.now()}`;
      await page.getByTestId('charge-beneficiary').fill(name);
      await page.getByTestId('charge-ht').fill('2500');
      await page.getByTestId('charge-vat').fill('0');
      await page.getByTestId('charge-save').click();
      await expect(page.getByTestId('charge-message')).toContainText('enregistrée');
      await page.reload();
      const row = page.getByTestId(`charge-row-${name}`);
      await expect(row).toContainText('À valider'); // 2 500 MAD: the middle band waits for another user
      await expect(row.getByTestId('charge-flag-no-document')).toBeVisible(); // no document reference: flagged, never silently accepted
      await expect(row.getByTestId('charge-pay')).toHaveCount(0); // not payable before its validation
    }
    await visit(page, locale, '/payment-requests', 'office-purchases-payment-requests');
    await expect(page.getByTestId('pr-j1')).toBeVisible();
    await visit(page, locale, '/instruments', 'office-purchases-instruments');
    await gone(page, locale, [
      '/margins',
      '/reminders',
      '/accounts',
      '/finance',
      '/costs',
      '/orders',
      '/statements/client/00000000-0000-0000-0000-000000000000',
    ]);
  });
}
