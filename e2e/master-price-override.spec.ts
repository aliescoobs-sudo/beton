import { expect, test } from '@playwright/test';
import { E2E_MD, loginAndEnrol } from './fixtures';

test.describe.configure({ mode: 'serial' });

// Versions only move forward: each run picks a date later than any previous run's (one day per 10 s).
const date = new Date(Date.UTC(2200, 0, 1) + Math.floor((Date.now() - 1.78e12) / 10_000) * 86_400_000)
  .toISOString()
  .slice(0, 10);
const name = `Client Prix E2E ${Date.now()}`;

test('a partner gives a client a price override with a reason, in French', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.ovPartnerFr.email);
  await page.getByTestId('clients-link').click();
  const create = page.getByTestId('client-new');
  await create.locator('input[name=name]').fill(name);
  await create.locator('button[type=submit]').click();
  await expect(create.getByTestId('client-message')).toHaveText('Enregistré.');
  await page.getByTestId(`client-${name}`).getByRole('link', { name }).click();

  const form = page.getByTestId('override-new');
  const b25 = await form.locator('option', { hasText: 'B25' }).getAttribute('value');
  await form.locator('select[name=concreteTypeId]').selectOption(b25 as string);
  await form.locator('input[name=price]').fill('880');
  await form.locator('input[name=effectiveFrom]').fill(date);
  // No reason: the browser blocks the submit (required); nothing is saved.
  await form.locator('button[type=submit]').click();
  await expect(page.getByTestId('override-row')).toHaveCount(0);
  await form.locator('textarea[name=reason]').fill('Accord cadre chantier Martil');
  await form.locator('button[type=submit]').click();
  await expect(page.getByTestId('override-row')).toContainText('880,00 MAD HT / m³');
  await expect(page.getByTestId('override-row')).toContainText('Accord cadre chantier Martil');
});

test('office sees the override but has no form', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.ovOffice.email);
  await page.getByTestId('clients-link').click();
  await page.getByTestId(`client-${name}`).getByRole('link', { name }).click();
  await expect(page.getByTestId('override-row')).toContainText('Accord cadre chantier Martil');
  await expect(page.getByTestId('override-new')).toHaveCount(0);
});

test('the overrides panel renders right-to-left in Arabic', async ({ page }) => {
  await loginAndEnrol(page, 'ar', E2E_MD.ovPartnerAr.email);
  await page.getByTestId('clients-link').click();
  const arabic = `زبون الأسعار ${Date.now()}`;
  const create = page.getByTestId('client-new');
  await create.locator('input[name=name]').fill(arabic);
  await create.locator('button[type=submit]').click();
  await expect(create.getByTestId('client-message')).toHaveText('تم الحفظ.');
  await page.getByTestId(`client-${arabic}`).getByRole('link', { name: arabic }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('overrides')).toBeVisible();
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
