import { expect, test } from '@playwright/test';
import { expectNoFields } from '../tests/helpers/expect-no-fields';
import { E2E_MD, loginAndEnrol } from './fixtures';

test.describe.configure({ mode: 'serial' });

// Versions only move forward: each run picks a date later than any previous run's (one day per 10 s).
const date = new Date(Date.UTC(2200, 0, 1) + Math.floor((Date.now() - 1.78e12) / 10_000) * 86_400_000)
  .toISOString()
  .slice(0, 10);

test('a partner publishes a recette version for B25 in French', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.recettePartnerFr.email);
  await page.getByTestId('recettes-link').click();
  await expect(page).toHaveURL('/fr/master-data/recettes');
  const form = page.getByTestId('recette-new-B25');
  await form.locator('input[name=effectiveFrom]').fill(date);
  await form.locator('input[name^=qty-]').first().fill('350');
  await form.locator('button[type=submit]').click();
  await expect(page.getByTestId('recette-B25')).toContainText(date);
  await expect(page.getByTestId('recette-B25')).toContainText('350 kg');
  // Typing grams where kilograms are expected (350 g instead of 350 kg) is flagged, not published.
  await form.locator('input[name^=qty-]').first().fill('0,35');
  await form.locator('input[name=effectiveFrom]').fill(date.replace(/^2200/, '2201'));
  await form.locator('button[type=submit]').click();
  await expect(form.getByTestId('recette-message')).toContainText('facteur 10');
  await expect(form.locator('button[type=submit]')).toHaveText('Publier quand même');
  await form.locator('input[name^=qty-]').first().fill('350');
  // Same date again: refused, nothing duplicated.
  await form.locator('input[name=effectiveFrom]').fill(date);
  await form.locator('button[type=submit]').click();
  await expect(form.getByTestId('recette-message')).toHaveText(
    'La date doit être postérieure à celle de la dernière version.',
  );
});

test('plant reads the recette with no form', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.recettePlant.email);
  await page.getByTestId('recettes-link').click();
  await expect(page.getByTestId('recette-B25')).toContainText('350 kg');
  await expect(page.locator('button[type=submit]')).toHaveCount(0);
  expectNoFields(await page.content(), [
    'componentCostPerM3Centimes',
    'purchase_price',
    'selling_price',
    'margin',
  ]);
  await expect(page.locator('body')).not.toContainText(/MAD|DH|prix|سعر/i);
});

test('the recettes screen renders right-to-left in Arabic', async ({ page }) => {
  await loginAndEnrol(page, 'ar', E2E_MD.recettePartnerAr.email);
  await page.getByTestId('recettes-link').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الوصفات');
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
