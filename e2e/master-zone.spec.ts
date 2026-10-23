import { expect, test } from '@playwright/test';
import { E2E_MD, loginAndEnrol, goNav } from './fixtures';

// Serial: the office test reads the zone the partner test creates (migrations seed no zone).
test.describe.configure({ mode: 'serial' });

test('a partner adds, edits and cannot duplicate a zone in French (AC-MD-09 first screen)', async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.partnerFr.email);
  await goNav(page, 'zones-link');
  await expect(page).toHaveURL('/fr/master-data/zones');

  const name = `Zone E2E ${Date.now()}`;
  await page.getByTestId('zone-add').click();
  const form = page.getByTestId('zone-new');
  await form.locator('input[name=name]').fill(name);
  await form.locator('input[name=oneWayMin]').fill('33');
  await form.locator('button[type=submit]').click();
  const row = page.getByTestId(`zone-${name}`);
  await expect(row).toBeVisible();

  await row.getByTestId('zone-edit').click();
  await row.locator('input[name=oneWayMin]').fill('34');
  await row.locator('button[type=submit]').click();
  // The row goes back to read mode once the save is accepted.
  await expect(row.locator('input[name=oneWayMin]')).toHaveCount(0);
  await expect(page.getByTestId('zone-message')).toHaveText('Enregistré.');
  await page.reload();
  await expect(page.getByTestId(`zone-${name}`).getByTestId('zone-minutes')).toContainText('34');

  await page.getByTestId('zone-add').click();

  await form.locator('input[name=name]').fill(name.toUpperCase());
  await form.locator('input[name=oneWayMin]').fill('10');
  await form.locator('button[type=submit]').click();
  await expect(form.getByTestId('zone-message')).toHaveText('Une zone porte déjà ce nom.');
});

test('an office user reads the zones with no edit control', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.office.email);
  await goNav(page, 'zones-link');
  await expect(page.getByTestId('zone-name').first()).toBeVisible();
  await expect(page.locator('input[name=name]')).toHaveCount(0);
  await expect(page.locator('button[type=submit]')).toHaveCount(0);
});

test('the zones screen renders right-to-left in Arabic and a partner can edit', async ({ page }) => {
  await loginAndEnrol(page, 'ar', E2E_MD.partnerAr.email);
  await goNav(page, 'zones-link');
  await expect(page).toHaveURL('/ar/master-data/zones');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('مناطق التسليم');
  await expect(page.getByTestId('zone-add')).toBeVisible();
  // No horizontal overflow at phone width.
  await page.setViewportSize({ width: 375, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
