import { expect, test } from '@playwright/test';

// AC-CLK-01 (UI part): with simulation disabled no sim badge is rendered. The positive case cannot run here:
// e2e serves a production build, and the boot guard (AC-CLK-02) refuses SIMULATION_ENABLED=true with it;
// it is covered by src/modules/clock/ui/sim-badge.test.tsx.
for (const locale of ['fr', 'ar']) {
  test(`no simulation badge in real mode (${locale})`, async ({ page }) => {
    await page.goto(`/${locale}/login`);
    await expect(page.getByTestId('sim-badge')).toHaveCount(0);
  });
}
