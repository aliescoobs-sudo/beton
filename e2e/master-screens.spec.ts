import { expect, test } from '@playwright/test';
import { loginOwner } from './fixtures';
import { checkScreen, watch } from './screen-check';

// T16 / AC-MD-09: every master-data screen, in fr (ltr) and ar (rtl), on a phone and a desktop width: right direction,
// no horizontal overflow, no missing translation (a missing key renders as its path), no CSP violation, Latin codes
// kept left-to-right inside Arabic text. A full-page screenshot of each is attached to the report.
const SCREENS = [
  'zones',
  'clients',
  'suppliers',
  'components',
  'concrete-types',
  'recettes',
  'purchase-prices',
  'selling-prices',
  'trucks',
] as const;
for (const locale of ['fr', 'ar'] as const) {
  test(`every master-data screen renders correctly in ${locale}`, async ({ page }) => {
    const problems = watch(page);
    // Only the owner reaches the price screens (DECISIONS 81), so the owner walks every master-data screen.
    await loginOwner(page, locale);

    for (const screen of SCREENS) {
      await page.goto(`/${locale}/master-data/${screen}`);
      await page.waitForLoadState('networkidle');
      await checkScreen(page, locale, screen);
    }

    // The client page, with its sites panel holding a long label and a long address (T4), and the seeded override.
    await page.goto(`/${locale}/master-data/clients`);
    await page.getByRole('link', { name: 'Entreprise Atlas BTP (fictif)' }).click();
    await expect(page.getByTestId('sites')).toBeVisible();
    const label = `Chantier ${'très-long-'.repeat(6)}${Date.now()}`;
    await page.getByTestId('site-add').click();
    const site = page.getByTestId('site-new');
    await site.locator('input[name=label]').fill(label);
    await site
      .locator('input[name=address]')
      .fill(`${'avenue Mohammed V, immeuble 12, étage 3, '.repeat(3)}Tétouan`);
    await site.locator('button[type=submit]').click();
    await expect(page.getByTestId(`site-${label}`)).toBeVisible();
    await page.waitForLoadState('networkidle');
    await checkScreen(page, locale, 'client-detail');

    expect(problems).toEqual([]);
  });
}
