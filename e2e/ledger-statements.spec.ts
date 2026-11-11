import { expect, test } from '@playwright/test';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// ledger L28: account statements. Owner and support read them and export a CSV; office has neither link nor page.
test.describe.configure({ mode: 'serial' });

const reference = `STM${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

test('the owner opens the statement of a client after a payment, filters it and exports a CSV', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await page.goto('/fr/payments/new');
  await page.getByTestId('payment-search').fill('Atlas');
  await page.getByTestId('payment-party').selectOption({ index: 1 });
  await page.getByTestId('payment-method').selectOption('transfer');
  await page.getByTestId('payment-amount').fill('500,00');
  await page.getByTestId('payment-number').fill(reference);
  await page.getByTestId('payment-save').click();
  await expect(page.getByTestId('payment-saved')).toBeVisible();

  await goNav(page, 'statements-link');
  await expect(page).toHaveURL('/fr/statements');
  await expect(page.getByTestId('accounts-client')).toBeVisible();
  await expect(page.getByTestId('accounts-supplier')).toBeVisible();
  await page
    .locator('[data-testid^="account-row-"]', { hasText: 'Atlas' })
    .getByTestId('account-open')
    .click();

  await expect(page.getByTestId('section-financial')).toContainText(reference);
  await expect(page.getByTestId('summary-balance')).toContainText('MAD');
  await expect(
    page.getByTestId('section-commercial').or(page.getByTestId('section-commercial-empty')),
  ).toBeVisible();

  // Filter by type: the commercial lines go, the payment stays, the balances are untouched.
  await page.getByTestId('filter-type').selectOption('payment');
  await page.getByTestId('filter-apply').click();
  await expect(page.getByTestId('section-financial')).toContainText(reference);
  await expect(page.getByTestId('section-commercial-empty')).toBeVisible();

  const href = await page.getByTestId('statement-export').getAttribute('href');
  expect(href).toContain('/export');
  const response = await page.request.get(href ?? '');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/csv');
  const body = await response.text();
  expect(body.charCodeAt(0)).toBe(0xfeff);
  expect(body).toContain(reference);
  expect(body).toContain('Solde de clôture');

  // The same statement as a PDF: a download that is never cached, with the pilot watermark.
  const pdfHref = await page.getByTestId('statement-pdf').getAttribute('href');
  expect(pdfHref).toContain('/pdf');
  const pdf = await page.request.get(pdfHref ?? '');
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect(pdf.headers()['content-disposition']).toContain('attachment');
  expect(pdf.headers()['cache-control']).toContain('no-store');
  expect(pdf.headers()['x-content-type-options']).toBe('nosniff');
  const bytes = await pdf.body();
  expect(bytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
  await logout(page);
});

test('office has no link, no page and no export', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.stmOffice.email);
  await expect(page.getByTestId('statements-link')).toHaveCount(0);
  expect((await page.goto('/fr/statements'))?.status()).toBe(404);
  expect(
    (await page.request.get('/fr/statements/client/00000000-0000-0000-0000-000000000000/export')).status(),
  ).toBe(404);
  for (const path of [
    '/fr/statements/client/00000000-0000-0000-0000-000000000000/pdf',
    '/fr/invoices/00000000-0000-0000-0000-000000000000/pdf',
    '/fr/avoirs/00000000-0000-0000-0000-000000000000/pdf',
    '/fr/quotes/00000000-0000-0000-0000-000000000000/pdf',
  ])
    expect((await page.request.get(path)).status()).toBe(404);
});

test('Arabic renders right-to-left with amounts and codes left-to-right', async ({ page }) => {
  await loginOwner(page, 'ar');
  await page.goto('/ar/statements');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page
    .locator('[data-testid^="account-row-"]', { hasText: 'Atlas' })
    .getByTestId('account-open')
    .click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('section-financial').locator('bdi[dir="ltr"]').first()).toBeVisible();
});
