import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { E2E_TRAINING_URL, E2E_BASE_URL, loginOwner } from './fixtures';

// KAYAS rebrand visual check: screenshots of FICTITIOUS data written OUTSIDE tracked files (the folder in KAYAS_VISUAL_DIR, e.g.
// .logs/visual-checks, which is git-ignored). Only with KAYAS_VISUAL_DIR set, so a normal run never writes images.
// It also asserts what the eye checks: the logo is not stretched, it has its clear space, the descriptor is a separate line.
const OUT = process.env.KAYAS_VISUAL_DIR;
test.skip(!OUT, 'set KAYAS_VISUAL_DIR to write the KAYAS visual-check screenshots');
test.describe.configure({ mode: 'serial' });

async function logoChecks(page: Page) {
  const img = page.locator('img[alt="KAYAS"]:visible').first();
  await expect(img).toBeVisible();
  const box = await img.boundingBox();
  const natural = await img.evaluate((el) => {
    const i = el as HTMLImageElement;
    return { w: i.naturalWidth, h: i.naturalHeight };
  });
  // never stretched: the rendered ratio equals the file's ratio (within a pixel of rounding)
  expect(Math.abs(box!.width / box!.height - natural.w / natural.h)).toBeLessThan(0.05);
  // clear space: the wrapper pads the image by a quarter of its height on every side
  const pad = await img.evaluate((el) => parseFloat(getComputedStyle(el.parentElement!).paddingTop));
  expect(Math.abs(pad - box!.height / 4)).toBeLessThanOrEqual(1.5);
  expect(box!.width).toBeGreaterThanOrEqual(120);
}

test('login fr and ar (RTL), with descriptor line and fonts', async ({ page }) => {
  mkdirSync(OUT!, { recursive: true });
  for (const locale of ['fr', 'ar'] as const) {
    await page.goto(`/${locale}/login`);
    await page.waitForLoadState('networkidle');
    await logoChecks(page);
    await expect(page.getByTestId('brand-descriptor')).toBeVisible();
    await expect(page.getByTestId('brand-descriptor')).not.toContainText('KAYAS');
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family);
    });
    expect(fonts.join(' ')).toContain('KAYAS Inter');
    if (locale === 'ar') {
      expect(await page.locator('html').getAttribute('dir')).toBe('rtl');
      expect(fonts.join(' ')).toContain('KAYAS Naskh');
    }
    await page.screenshot({ path: `${OUT}/login-${locale}.png`, fullPage: true });
  }
});

test('owner dashboard and a plant screen, desktop, fr and ar', async ({ page }) => {
  for (const locale of ['fr', 'ar'] as const) {
    await loginOwner(page, locale);
    await page.waitForLoadState('networkidle');
    await logoChecks(page);
    await page.screenshot({ path: `${OUT}/owner-dashboard-${locale}.png`, fullPage: true });
    await page.goto(`/${locale}/loads`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `${OUT}/plant-screen-${locale}.png`, fullPage: true });
    await page.context().clearCookies();
  }
});

test('driver phone view at 390 px (ar) and the drawer', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    baseURL: E2E_BASE_URL,
  });
  const page = await ctx.newPage();
  await page.goto('/ar/driver');
  await page.getByTestId('field-code').waitFor();
  await page.screenshot({ path: `${OUT}/driver-phone-ar-390.png`, fullPage: true });
  // a 44 px touch target on the sign-in button
  const submit = page.getByTestId('field-signin');
  if (await submit.isVisible()) expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await ctx.close();
});

test('training banner stays red and distinct from the brand', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: E2E_TRAINING_URL });
  const page = await ctx.newPage();
  await page.goto('/fr/login');
  const banner = page.getByTestId('training-banner');
  await expect(banner).toBeVisible();
  const bg = await banner.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(210, 58, 30)'); // signal red #d23a1e, not Forêt nor Citron
  await page.screenshot({ path: `${OUT}/training-banner-fr.png` });
  await ctx.close();
});
