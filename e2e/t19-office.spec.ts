import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { addClientAlias, setClientTerms } from '../src/modules/ledger';
import { createClient } from '../src/modules/master-data';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { E2E_MD, loginAndEnrol, loginOwner } from './fixtures';

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
    await visit(page, locale, '/aging', 'office-sales-aging');
    await expect(page.getByTestId('aging-client')).toBeVisible();
    await expect(page.getByTestId('aging-supplier')).toHaveCount(0);
    await visit(page, locale, '/forecast', 'office-sales-forecast');
    await expect(page.getByTestId('forecast-client_cheque')).toBeVisible();
    await expect(page.getByTestId('forecast-issued_cheque')).toHaveCount(0);
    await expect(page.getByTestId('forecast-net')).toHaveCount(0);
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
    await visit(page, locale, '/aging', 'office-purchases-aging');
    await expect(page.getByTestId('aging-supplier')).toBeVisible();
    await expect(page.getByTestId('aging-client')).toHaveCount(0);
    await visit(page, locale, '/forecast', 'office-purchases-forecast');
    await expect(page.getByTestId('forecast-issued_cheque')).toBeVisible();
    await expect(page.getByTestId('forecast-client_cheque')).toHaveCount(0);
    await expect(page.getByTestId('forecast-instalment')).toHaveCount(0);
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

// T19-close C: the order form says when the chosen client requires its PO number (the field is then mandatory) and its client search matches aliases.
test('the order form searches by alias and makes the PO number mandatory for a client that requires it (French)', async ({
  page,
}) => {
  const env = testEnv(E2E_DATABASE);
  const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
  try {
    const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
    const tag = Math.random().toString(36).slice(2, 8).toUpperCase();
    const created = await createClient(app, owner, { name: `Chantier BC E2E ${tag}`, kind: 'company' });
    if (!created.ok) throw new Error(created.error);
    const clientId = created.value.client.id;
    const alias = `Surnom BC ${tag}`;
    expect((await addClientAlias(app, owner, { clientId, alias })).ok).toBe(true);
    expect((await setClientTerms(app, owner, { clientId, poRequired: true, priceBasis: 'HT' })).ok).toBe(
      true,
    );

    await loginOwner(page, 'fr');
    await page.goto('/fr/orders/new');
    // an alias finds the client, and the list says which alias matched
    await page.getByTestId('order-client-search').fill(alias);
    const option = page.getByTestId('order-client').locator('option', { hasText: `Chantier BC E2E ${tag}` });
    await expect(option).toHaveCount(1);
    await expect(option).toContainText(alias);
    await page.getByTestId('order-client').selectOption(clientId);
    await expect(page.getByTestId('order-po-required-note')).toContainText('exige le numéro');
    await page.getByTestId('order-volume').fill('5');
    await page.getByTestId('order-method').selectOption('GOULOTTE');
    // the delivery step does not let the person go on without the PO number
    await page.getByTestId('order-next').click();
    await expect(page.getByTestId('order-po')).toHaveAttribute('required', '');
    await page.getByTestId('order-next').click();
    await expect(page.getByTestId('order-message')).toContainText('exige le numéro');
    await expect(page.getByTestId('order-step-delivery')).toBeVisible();
    await page.getByTestId('order-po').fill(`BC-E2E-${tag}`);
    await page.getByTestId('order-next').click();
    await expect(page.getByTestId('order-save')).toBeVisible();
  } finally {
    await app.end();
  }
});

// T19c B2/B3: the owner reads both sides of the aging and the forecast with the net line; the CSV export is served (and audited).
test('the owner sees both sides of the aging and the forecast with the net line, and exports the aging (French)', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await visit(page, 'fr', '/aging', 'owner-aging');
  await expect(page.getByTestId('aging-client')).toBeVisible();
  await expect(page.getByTestId('aging-supplier')).toBeVisible();
  const csv = await page.request.get('/fr/aging/export?kind=client');
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');
  expect((await csv.text()).split('\n')[0]).toBe(
    'code;name;current;d1_30;d31_60;d61_90;d90plus;no_due_date;total',
  );
  expect((await page.request.get('/fr/aging/export?kind=other')).status()).toBe(404);
  await visit(page, 'fr', '/forecast', 'owner-forecast');
  for (const id of ['client_cheque', 'issued_cheque', 'instalment', 'net'])
    await expect(page.getByTestId(`forecast-${id}`)).toBeVisible();
});
