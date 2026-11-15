import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { E2E_BASE_URL, E2E_MD, loginAndEnrol, loginOwner, orderStep } from './fixtures';

// T18-UI: the look-and-feel pass. Assertions run on every e2e run; the screenshots (docs/ui/screenshots) only with UI_SCREENSHOTS=1:
//   UI_SCREENSHOTS=1 NEXT_DIST_DIR=.next-e2e pnpm exec playwright test e2e/t18-ui.spec.ts
// Fictitious data only. No request may leave the application's own origin (no CDN, no Google Fonts).
test.describe.configure({ mode: 'serial' });
const SHOTS = Boolean(process.env.UI_SCREENSHOTS);
const OUT = 'docs/ui/screenshots';
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 375, height: 800 };

const external: string[] = [];
function watchNetwork(page: Page) {
  page.on('request', (r) => {
    const url = r.url();
    if (!url.startsWith(E2E_BASE_URL) && !url.startsWith('data:') && !url.startsWith('blob:'))
      external.push(url);
  });
}
const noSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
async function shot(page: Page, name: string, fullPage = true) {
  if (!SHOTS) return;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
}

/** Every shell control a finger can hit is at least 44 px on the phone, the bottom bar is there and shows only this role's groups. */
async function phoneShell(page: Page, locale: string) {
  await page.setViewportSize(PHONE);
  await page.goto(`/${locale}`);
  await page.waitForLoadState('networkidle');
  const bar = page.getByTestId('bottom-bar');
  await expect(bar).toBeVisible();
  const links = bar.locator('a');
  expect(await links.count()).toBeGreaterThanOrEqual(2);
  for (const box of await Promise.all((await links.all()).map((l) => l.boundingBox()))) {
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  for (const id of ['menu-button', 'user-menu']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box!.height, id).toBeGreaterThanOrEqual(44);
    expect(box!.width, id).toBeGreaterThanOrEqual(44);
  }
  expect(await noSideways(page)).toBe(true);
  // the bottom bar never offers a group the top tabs do not (UI only: the same server-filtered groups)
  await page.setViewportSize(DESKTOP);
  const tabs = await page
    .locator('[data-testid^="tab-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('tab-', '')));
  await page.setViewportSize(PHONE);
  for (const id of await bar
    .locator('a')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('bottom-', ''))))
    expect(tabs).toContain(id);
}

test('owner: the 5-second home, the shell, the order flow in Arabic (RTL), the lists; no external request', async ({
  page,
}) => {
  watchNetwork(page);
  await loginOwner(page, 'fr');
  await page.setViewportSize(DESKTOP);
  // the order flow, three steps, French
  await page.goto('/fr/orders/new');
  await expect(page.getByTestId('order-step-lines')).toBeVisible();
  await shot(page, 'order-flow-1-fr');
  await page.getByTestId('order-next').click();
  // an incomplete first step does not advance
  await expect(page.getByTestId('order-step-lines')).toBeVisible();
  await expect(page.getByTestId('order-message')).toBeVisible();
  await page.getByTestId('order-client-search').fill('Atlas');
  await page.getByTestId('order-client').selectOption({ index: 1 });
  await page.getByTestId('order-type').selectOption({ label: 'B25 · Béton B25' });
  await page.getByTestId('order-volume').fill('4');
  await page.getByTestId('order-method').selectOption('POMPE');
  await page.getByTestId('order-next').click();
  await expect(page.getByTestId('order-step-delivery')).toBeVisible();
  // fields with no backend yet are shown, disabled, with a note
  await expect(page.getByTestId('order-hour')).toBeDisabled();
  await expect(page.getByTestId('order-po')).toBeDisabled();
  await shot(page, 'order-flow-2-fr');
  await page.getByTestId('order-next').click();
  await expect(page.getByTestId('order-step-summary')).toBeVisible();
  await expect(page.getByTestId('order-recap')).toContainText('4');
  await shot(page, 'order-flow-3-fr');

  await page.getByTestId('order-preset').selectOption('cash');
  await page.getByTestId('order-save').click();
  await expect(page.getByTestId('order-saved')).toContainText('CMD-');
  await page.waitForLoadState('networkidle');

  await page.goto('/fr');
  await page.waitForLoadState('networkidle');
  await page.setViewportSize(DESKTOP);
  await expect(page.getByTestId('five-seconds')).toBeVisible();
  await expect(page.getByTestId('cash-real')).toBeVisible();
  await shot(page, 'home-owner-fr');
  // skip link: first Tab stop, jumps to main
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('skip-link')).toBeFocused();
  await phoneShell(page, 'fr');
  await shot(page, 'home-owner-fr-phone', false);

  // lists: filters row, chips, sort, pagination, reset
  await page.setViewportSize(DESKTOP);
  await page.goto('/fr/orders');
  await expect(page.getByTestId('orders-filters')).toBeVisible();
  await expect(page.getByTestId('status-chips')).toBeVisible();
  await page.goto('/fr/orders?sort=code&dir=desc&state=open');
  await expect(page.getByTestId('sort-code')).toBeVisible();
  await shot(page, 'orders-list-filters-fr');
  await page.goto('/fr/margins');
  await expect(page.getByTestId('margins-filters')).toBeVisible();
  await expect(page.getByTestId('margins-apply')).toBeVisible();
  await shot(page, 'margins-fr');
  await page.goto('/fr/pump-check');
  await expect(page.getByTestId('status-chips')).toBeVisible();
  await shot(page, 'pump-check-fr');
  await page.goto('/fr/fuel-check');
  await expect(page.getByTestId('fuel-check-filters')).toBeVisible();

  // Arabic: right to left, no sideways scroll on a phone, numbers left-to-right
  await page.goto('/ar/orders/new');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await shot(page, 'order-flow-1-ar');
  await page.setViewportSize(PHONE);
  for (const n of [1, 2, 3] as const) {
    await orderStep(page, n);
    expect(await noSideways(page), `order step ${n}`).toBe(true);
  }
  await page.setViewportSize(DESKTOP);
  await page.goto('/ar');
  await expect(page.getByTestId('five-seconds')).toBeVisible();
  await shot(page, 'home-owner-ar');
  await phoneShell(page, 'ar');
  await shot(page, 'home-owner-ar-phone', false);
  for (const path of ['/ar/orders', '/ar/margins', '/ar/pump-check', '/ar/fuel-check']) {
    await page.setViewportSize(PHONE);
    await page.goto(path);
    expect(await noSideways(page), path).toBe(true);
  }
  await page.setViewportSize(DESKTOP);
  await page.goto('/ar/margins');
  await shot(page, 'margins-ar');
  await page.goto('/ar/pump-check');
  await shot(page, 'pump-check-ar');

  expect(external, 'requests that left the application origin').toEqual([]);
});

for (const [name, key, locale] of [
  ['office', 't18OfficeFr', 'fr'],
  ['office', 't18OfficeAr', 'ar'],
  ['plant', 't18PlantFr', 'fr'],
  ['plant', 't18PlantAr', 'ar'],
] as const) {
  test(`${name} home, ${locale}: ops layout, no money, phone shell`, async ({ page }) => {
    watchNetwork(page);
    await loginAndEnrol(page, locale, E2E_MD[key].email);
    await page.setViewportSize(DESKTOP);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('ops-today')).toBeVisible();
    await expect(page.getByTestId('ops-kpis')).toBeVisible();
    await expect(page.getByTestId('five-seconds')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/MAD/);
    if (locale === 'ar') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await shot(page, `home-${name}-${locale}`);
    await phoneShell(page, locale);
    await shot(page, `home-${name}-${locale}-phone`, false);
    expect(external).toEqual([]);
  });
}

test('driver phone sign-in, fr and ar: self-hosted fonts only', async ({ page }) => {
  watchNetwork(page);
  await page.setViewportSize(PHONE);
  for (const locale of ['fr', 'ar'] as const) {
    await page.goto(`/${locale}/driver`);
    // the phone app keeps its sync loop alive: wait for its sign-in button, not for an idle network
    await expect(page.getByTestId('field-signin')).toBeVisible();
    expect(await noSideways(page)).toBe(true);
    await shot(page, `home-driver-${locale}-phone`, false);
  }
  expect(external).toEqual([]);
});
