import { mkdirSync } from 'node:fs';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { buildNav } from '../src/app/shell/nav-model';
import { E2E_BASE_URL, E2E_PASSWORD, E2E_TRAINING_URL, E2E_TRAINING_USER, loginOwner } from './fixtures';

// T8-D: the phone frame (390 and 522 px), fr and ar. Screenshots of FICTITIOUS data go to .logs/visual-checks (git-ignored).
const OUT = '.logs/visual-checks';
const WIDTHS = [390, 522] as const;
const LOCALES = ['fr', 'ar'] as const;
test.describe.configure({ mode: 'serial' });

const phone = (browser: import('@playwright/test').Browser, baseURL: string) =>
  browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, baseURL });

/** The sections of the drawer, by test id, and the single-link ones (direct links). */
async function sectionIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="drawer-section-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('drawer-section-', '')));
}

async function openDrawer(page: Page) {
  await page.getByTestId('menu-button').click();
  await expect(page.locator('#app-drawer')).toBeVisible();
}

test.describe('owner', () => {
  let ctx: BrowserContext;
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    mkdirSync(OUT, { recursive: true });
    ctx = await phone(browser, E2E_BASE_URL);
    page = await ctx.newPage();
    await loginOwner(page, 'fr');
  });
  test.afterAll(async () => ctx.close());

  for (const locale of LOCALES) {
    for (const width of WIDTHS) {
      test(`drawer accordion, ${locale}, ${width} px`, async () => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`/${locale}`);
        await page.waitForLoadState('networkidle');
        const rtl = locale === 'ar';
        expect(await page.locator('html').getAttribute('dir')).toBe(rtl ? 'rtl' : 'ltr');
        await page.screenshot({ path: `${OUT}/phone-home-${locale}-${width}.png` });

        await openDrawer(page);
        const ids = await sectionIds(page);
        expect(ids.length).toBeGreaterThan(2);
        // closed: every section is collapsed (the dashboard is a direct link), only the headers show, and the panel fits without scrolling
        for (const id of ids) {
          const head = page.getByTestId(`drawer-section-${id}`);
          await expect(head).toHaveAttribute('aria-expanded', 'false');
          const controls = (await head.getAttribute('aria-controls'))!;
          await expect(page.locator(`#${controls}`)).toBeHidden();
          expect((await head.boundingBox())!.height).toBeGreaterThanOrEqual(48);
        }
        await expect(page.getByTestId('drawer-home-link')).toBeVisible();
        const fits = await page
          .locator('#app-drawer > div:last-child')
          .evaluate((el) => el.scrollHeight <= el.clientHeight);
        expect(fits, 'the closed drawer fits without scrolling').toBe(true);
        await page.screenshot({ path: `${OUT}/phone-drawer-closed-${locale}-${width}.png` });

        // one at a time
        await page.getByTestId(`drawer-section-${ids[0]}`).click();
        await expect(page.getByTestId(`drawer-section-${ids[0]}`)).toHaveAttribute('aria-expanded', 'true');
        await page.getByTestId(`drawer-section-${ids[1]}`).click();
        await expect(page.getByTestId(`drawer-section-${ids[1]}`)).toHaveAttribute('aria-expanded', 'true');
        await expect(page.getByTestId(`drawer-section-${ids[0]}`)).toHaveAttribute('aria-expanded', 'false');
        await page.screenshot({ path: `${OUT}/phone-drawer-open-${locale}-${width}.png` });
        // tapping the open one again collapses it
        await page.getByTestId(`drawer-section-${ids[1]}`).click();
        await expect(page.getByTestId(`drawer-section-${ids[1]}`)).toHaveAttribute('aria-expanded', 'false');

        // the chevron is mirrored in RTL (closed = points to the inline end); Tailwind sets the CSS `scale` property
        const scale = await page
          .getByTestId(`drawer-section-${ids[0]}`)
          .locator('svg')
          .evaluate((el) => getComputedStyle(el).scale);
        expect(scale === 'none' ? 1 : Number(scale.split(' ')[0])).toBe(rtl ? -1 : 1);

        // every target of the drawer is at least 44 x 44
        await page.getByTestId(`drawer-section-${ids[0]}`).click();
        const small = await page
          .locator('#app-drawer button:visible, #app-drawer a:visible, #app-drawer input:visible')
          .evaluateAll((els) =>
            els
              .map((el) => ({ id: el.getAttribute('data-testid'), r: el.getBoundingClientRect() }))
              .filter(({ r }) => r.width < 44 || r.height < 44)
              .map(({ id, r }) => `${id}:${Math.round(r.width)}x${Math.round(r.height)}`),
          );
        expect(small).toEqual([]);

        // Escape closes the drawer and the focus goes back to the Menu button
        await page.keyboard.press('Escape');
        await expect(page.locator('#app-drawer')).toBeHidden();
        await expect(page.getByTestId('menu-button')).toBeFocused();
      });
    }
  }

  test('the section of the current page is open, with the active link marked', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/fr/master-data/clients');
    await openDrawer(page);
    await expect(page.getByTestId('drawer-section-sales')).toHaveAttribute('aria-expanded', 'true');
    const link = page.getByTestId('drawer-clients-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('aria-current', 'page');
    expect(await link.evaluate((el) => getComputedStyle(el).borderInlineStartColor)).toBe('rgb(154, 218, 2)');
    // the search box keeps its place at the top and filters across all sections as a flat list with the section names
    const box = page.getByTestId('drawer-search-box');
    await box.fill('client');
    const matches = page.getByTestId('drawer-matches');
    await expect(matches).toBeVisible();
    expect(await matches.locator('a').count()).toBeGreaterThan(0);
    await box.fill('zzzzzzzz');
    await expect(page.getByTestId('drawer-no-match')).toBeVisible();
    await box.fill('');
    await expect(page.getByTestId('drawer-section-sales')).toBeVisible();
    // Enter on a header opens it (keyboard)
    await page.getByTestId('drawer-section-purchases').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('drawer-section-purchases')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('drawer-section-purchases')).toHaveAttribute('aria-expanded', 'false');
  });

  test('no main page scrolls sideways at 390 px (fr and ar)', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const paths = [
      '',
      '/orders',
      '/invoices',
      '/stock',
      '/quotes',
      '/payments',
      '/deliveries',
      '/purchases',
      '/receipts',
      '/dispatch',
      '/trips',
      '/documents',
      '/documents/requests',
      '/credit-limits',
      '/approvals',
      '/cash',
      '/deadlines',
      '/instruments',
      '/statements',
      '/master-data/clients',
      '/master-data/suppliers',
      '/master-data/concrete-types',
      '/master-data/components',
      '/master-data/trucks',
      '/admin/users',
      '/alerts',
      '/notifications',
    ];
    const bad: string[] = [];
    for (const locale of LOCALES) {
      for (const path of paths) {
        await page.goto(`/${locale}${path}`);
        await page.waitForLoadState('load');
        const over = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          iw: window.innerWidth,
        }));
        if (over.sw > over.iw) bad.push(`${locale}${path}: ${over.sw} > ${over.iw}`);
        if (path === '/orders' || path === '/invoices' || path === '/stock')
          await page.screenshot({ path: `${OUT}/phone-${path.slice(1)}-${locale}-390.png` });
      }
    }
    expect(bad).toEqual([]);
  });

  test('tables become cards on a phone and stay tables on a desktop; document numbers do not wrap', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/fr/master-data/concrete-types');
    const table = page.locator('table.data-table').first();
    await expect(table).toBeVisible();
    await expect(table).toHaveAttribute('data-mobile', 'cards');
    const row = table.locator('tbody tr').first();
    expect(await row.evaluate((el) => getComputedStyle(el).display)).toBe('block');
    expect(await table.locator('tbody td[data-label]:not([data-label=""])').count()).toBeGreaterThan(0);
    expect(
      await table.evaluate(
        (el) => (el.parentElement as HTMLElement).scrollWidth <= el.parentElement!.clientWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({ path: `${OUT}/phone-cards-fr-390.png` });
    await page.setViewportSize({ width: 1280, height: 800 });
    expect(await row.evaluate((el) => getComputedStyle(el).display)).toBe('table-row');
    // a code isolated left-to-right never wraps
    const wraps = await page.evaluate(() =>
      [...document.querySelectorAll('bdi[dir="ltr"]')].every(
        (b) => getComputedStyle(b).whiteSpace === 'nowrap',
      ),
    );
    expect(wraps).toBe(true);
  });

  test('touch targets: header and tab strip on a phone are at least 44 px', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/fr/master-data/clients');
    await page.waitForLoadState('networkidle');
    const small = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('header a, header button, nav[aria-label] a')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
        if (r.width < 44 || r.height < 44)
          out.push(
            `${el.getAttribute('data-testid') ?? el.tagName}:${Math.round(r.width)}x${Math.round(r.height)}`,
          );
      }
      return out;
    });
    expect(small).toEqual([]);
  });

  test('the sub-navigation strip scrolls with a visible hint, and no tab is squeezed under its text (fr and ar)', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const locale of LOCALES) {
      await page.goto(`/${locale}/orders`);
      const strip = page.locator('nav.scroll-hint').first();
      await expect(strip).toBeVisible();
      expect(await strip.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('linear-gradient');
      const squeezed = await strip
        .locator('a')
        .evaluateAll((els) => els.filter((a) => a.scrollWidth > a.clientWidth + 1).map((a) => a.textContent));
      expect(squeezed, 'tabs whose text overflows their box').toEqual([]);
      const overlaps = await strip.locator('a').evaluateAll((els) => {
        const boxes = els.map((a) => a.getBoundingClientRect());
        return boxes.filter(
          (b, i) =>
            i > 0 && Math.abs(b.left - boxes[i - 1]!.left) < Math.min(b.width, boxes[i - 1]!.width) - 1,
        ).length;
      });
      expect(overlaps).toBe(0);
      await page.screenshot({ path: `${OUT}/phone-subnav-${locale}-390.png` });
    }
  });

  test('branded 404 in French and Arabic', async () => {
    for (const locale of LOCALES) {
      const res = await page.goto(`/${locale}/cette-page-n-existe-pas`);
      expect(res?.status()).toBe(404);
      await expect(page.getByTestId('not-found-body')).toBeVisible();
      await expect(page.getByTestId('not-found-home')).toHaveAttribute('href', `/${locale}`);
      expect(await page.locator('html').getAttribute('dir')).toBe(locale === 'ar' ? 'rtl' : 'ltr');
      expect(
        await page
          .locator('header')
          .first()
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      ).toBe('rgb(1, 89, 43)');
      await page.screenshot({ path: `${OUT}/phone-404-${locale}-390.png` });
    }
  });
});

test.describe('office_sales (training server)', () => {
  for (const locale of LOCALES) {
    for (const width of WIDTHS) {
      test(`sees only its allowed sections, ${locale}, ${width} px`, async ({ browser }) => {
        const ctx = await phone(browser, E2E_TRAINING_URL);
        const page = await ctx.newPage();
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`/${locale}/login`);
        await page.fill('input[name=email]', E2E_TRAINING_USER.email);
        await page.fill('input[name=password]', E2E_PASSWORD);
        await page.click('button[type=submit]');
        await expect(page).toHaveURL(`${E2E_TRAINING_URL}/${locale}`);
        await openDrawer(page);
        const expected = buildNav('office_sales', locale, (k) => k)
          .filter((g) => g.links.length > 1)
          .map((g) => g.id)
          .sort();
        expect((await sectionIds(page)).sort()).toEqual(expected);
        // nothing the role cannot open is listed once everything is expanded
        const allowed = buildNav('office_sales', locale, (k) => k).flatMap((g) => g.links.map((l) => l.href));
        for (const id of expected) await page.getByTestId(`drawer-section-${id}`).click();
        const shown = await page
          .locator('#app-drawer a')
          .evaluateAll((els) => els.map((e) => e.getAttribute('href')!));
        for (const href of shown) expect(allowed, href).toContain(href);
        await page.screenshot({ path: `${OUT}/phone-drawer-office-sales-${locale}-${width}.png` });
        const fits = await page
          .locator('#app-drawer > div:last-child')
          .evaluate((el) => el.scrollHeight <= el.clientHeight);
        void fits;
        await ctx.close();
      });
    }
  }
});
