import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { E2E_MD, loginAndEnrol } from './fixtures';

// Design review screenshots (full page, desktop and phone) written to docs/ui/screenshots. Only with
// UI_SCREENSHOTS=1, so a normal e2e run never rewrites tracked images:  UI_SCREENSHOTS=1 pnpm exec playwright test e2e/design-screenshots.spec.ts
const OUT = 'docs/ui/screenshots';
test.skip(!process.env.UI_SCREENSHOTS, 'set UI_SCREENSHOTS=1 to regenerate the design screenshots');

const SCREENS = [
  ['home', ''],
  ['clients', '/master-data/clients'],
  ['recettes', '/master-data/recettes'],
  ['zones', '/master-data/zones'],
  ['trucks', '/master-data/trucks'],
  ['purchase-prices', '/master-data/purchase-prices'],
  ['parameters', '/parameters'],
  ['audit', '/historique'],
] as const;

for (const locale of ['fr', 'ar'] as const) {
  test(`design screenshots ${locale}`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const user = locale === 'ar' ? E2E_MD.screensPartnerAr : E2E_MD.screensPartnerFr;
    await loginAndEnrol(page, locale, user.email);
    for (const [name, path] of SCREENS) {
      await page.goto(`/${locale}${path}`);
      await page.waitForLoadState('networkidle');
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.screenshot({ path: `${OUT}/${name}-${locale}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/${locale}`);
    await page.screenshot({ path: `${OUT}/home-${locale}-phone.png` });
    await page.getByTestId('menu-button').click();
    await expect(page.getByTestId('clients-link')).toBeVisible();
    await page.screenshot({ path: `${OUT}/menu-${locale}-phone.png` });
  });
}
