import { expect, test } from '@playwright/test';
import { E2E_MD, loginAndEnrol, loginOwner, goNav } from './fixtures';

test.describe.configure({ mode: 'serial' });

// Versions only move forward: each run picks a date later than any previous run's (one day per 10 s).
const date = new Date(Date.UTC(2200, 0, 1) + Math.floor((Date.now() - 1.78e12) / 10_000) * 86_400_000)
  .toISOString()
  .slice(0, 10);
const name = `Client Prix E2E ${Date.now()}`;

test('the owner gives a client a price override with a reason, in French', async ({ page }) => {
  await loginOwner(page, 'fr');
  await goNav(page, 'clients-link');
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

test('office sees no price panel (DECISIONS 81)', async ({ browser }) => {
  for (const user of [E2E_MD.ovOffice]) {
    const other = await browser.newPage();
    await loginAndEnrol(other, 'fr', user.email);
    await goNav(other, 'clients-link');
    await other.getByTestId(`client-${name}`).getByRole('link', { name }).click();
    await expect(other.getByTestId('overrides')).toHaveCount(0);
    await expect(other.locator('body')).not.toContainText('Accord cadre chantier Martil');
    await expect(other.locator('body')).not.toContainText('MAD');
    await other.close();
  }
});

test('the overrides panel renders right-to-left in Arabic', async ({ page }) => {
  await loginOwner(page, 'ar');
  await goNav(page, 'clients-link');
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
