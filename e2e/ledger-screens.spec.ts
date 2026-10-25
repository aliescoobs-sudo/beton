import { expect, test } from '@playwright/test';
import { loginOwner } from './fixtures';
import { checkScreen, watch } from './screen-check';

// ledger L25 (AC-MD-09 style): every ledger and operations screen, in fr (ltr) and ar (rtl), on a phone and a desktop width:
// right direction, no horizontal overflow, no missing translation, no CSP violation, Latin codes and numbers left-to-right.
const SCREENS = [
  'quotes',
  'quotes/new',
  'orders',
  'orders/new',
  'invoices',
  'invoices/new',
  'purchases',
  'purchases/new',
  'deadlines',
  'accounting',
  'company',
  'instruments',
  'payments/new',
  'cash',
  'accounts',
  'statements',
  'opening',
  'loads',
  'stock',
  'receipts',
] as const;

for (const locale of ['fr', 'ar'] as const) {
  test(`every ledger and operations screen renders correctly in ${locale}`, async ({ page }) => {
    const problems = watch(page);
    await loginOwner(page, locale);

    for (const screen of SCREENS) {
      await page.goto(`/${locale}/${screen}`);
      await page.waitForLoadState('networkidle');
      await checkScreen(page, locale, screen);
    }

    // The detail pages: the first order, invoice, purchase and delivery note of the day.
    for (const [list, link] of [
      ['quotes', 'a[href*="/quotes/"]'],
      ['orders', 'a[href*="/orders/"]'],
      ['invoices', 'a[href*="/invoices/"]'],
      ['purchases', 'a[href*="/purchases/"]'],
      ['loads', 'a[href*="/deliveries/"]'],
    ] as const) {
      await page.goto(`/${locale}/${list}`);
      const first = page.locator(`table ${link}`).first();
      if ((await first.count()) === 0) continue;
      await first.click();
      await page.waitForLoadState('networkidle');
      await checkScreen(page, locale, `${list}-detail`);
    }
    expect(problems).toEqual([]);
  });
}
