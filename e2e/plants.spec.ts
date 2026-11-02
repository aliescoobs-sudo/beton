import { expect, test } from '@playwright/test';
import { E2E_MD, goNav, loginAndEnrol } from './fixtures';

// R1 (AC-PROD-01): the plants screen. The e2e database is shared by every spec: a plant added here is archived again before
// the test ends, so the plant rule (a row must name its plant once two are active) never reaches another spec.
test.describe.configure({ mode: 'serial' });

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

test('a partner adds a plant, sees it on the stock screen, then archives it (French)', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.plantsPartnerFr.email);
  await goNav(page, 'plants-link');
  await expect(page).toHaveURL('/fr/master-data/plants');

  const code = letters(6);
  const form = page.getByTestId('plant-new');
  await form.locator('input[name=code]').fill(code);
  await form.locator('input[name=name]').fill(`Centrale ${code}`);
  await page.getByTestId('plant-add').click();
  const row = page.getByTestId(`plant-${code}`);
  await expect(row).toBeVisible();
  await expect(page.getByTestId('plant-message')).toHaveText('Enregistré.');

  // a duplicate code is refused with a message
  await form.locator('input[name=code]').fill(code);
  await form.locator('input[name=name]').fill(`Autre ${code}`);
  await page.getByTestId('plant-add').click();
  await expect(page.getByTestId('plant-message')).toHaveText('Une centrale porte déjà ce code ou ce nom.');

  // with an active plant the stock screen offers the total and one tab per plant
  await page.goto('/fr/stock');
  await expect(page.getByTestId('stock-plants')).toBeVisible();
  await expect(page.getByTestId('stock-plant-total')).toBeVisible();

  await page.goto('/fr/master-data/plants');
  await page.getByTestId(`plant-toggle-${code}`).click();
  await expect(page.getByTestId(`plant-${code}`)).toContainText('Archivée');
  await page.goto('/fr/stock');
  await expect(page.getByTestId('stock-plants')).toHaveCount(0);
});

test('an office user reads the plants with no edit control', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.plantsOffice.email);
  await goNav(page, 'plants-link');
  await expect(page.getByTestId('plants-list')).toBeVisible();
  await expect(page.getByTestId('plant-new')).toHaveCount(0);
  await expect(page.locator('button[type=submit]')).toHaveCount(0);
});

test('the plants screen renders right-to-left in Arabic without overflow at phone width', async ({
  page,
}) => {
  await loginAndEnrol(page, 'ar', E2E_MD.plantsPartnerAr.email);
  await goNav(page, 'plants-link');
  await expect(page).toHaveURL('/ar/master-data/plants');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('المحطات');
  await page.setViewportSize({ width: 375, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
