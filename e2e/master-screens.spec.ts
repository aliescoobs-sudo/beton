import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { E2E_MD, loginAndEnrol } from './fixtures';

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
const WIDTHS = [375, 1280] as const;
const NAMESPACES = Object.keys(JSON.parse(readFileSync('messages/fr.json', 'utf8')) as object);
const KEY_PATH = new RegExp(`\\b(${NAMESPACES.join('|')})\\.[A-Za-z][A-Za-z0-9]*`);
// Codes that must read left-to-right whatever the page direction.
const LATIN_CODE = /\b(?:CLT|FRN|CMP)-\d+\b|\bT\d{1,3}\b|\bB\d{2}\b|\b\d{15}\b|\b\d{5}-[A-Z]-\d\b/;

function watch(page: Page) {
  const problems: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Refused to (load|execute|apply)|MISSING_MESSAGE/i.test(text))
      problems.push(text);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

async function checkScreen(page: Page, locale: 'fr' | 'ar', name: string) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect.soft(overflow, `${name} ${locale} ${width}px overflows horizontally`).toBeLessThanOrEqual(0);
    const text = await page.locator('body').innerText();
    expect(
      text.match(KEY_PATH)?.[0],
      `${name} ${locale}: a translation key is shown as text`,
    ).toBeUndefined();
    await test.info().attach(`${name}-${locale}-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  // Latin codes and numbers sit in an LTR isolate (dir="ltr" or <bdi>) when the page is RTL.
  const exposed = await page.evaluate((source) => {
    const code = new RegExp(source);
    const bad: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // A code wrapped in Unicode isolates (U+2066 … U+2069) inside a message is already isolated.
      const match = code.exec((node.textContent ?? '').replace(/\u2066[^\u2069]*\u2069/g, ''));
      const parent = node.parentElement;
      if (!match || !parent || parent.closest('script,style,option')) continue;
      const isolated = parent.closest('[dir=ltr], bdi');
      if (!isolated) bad.push(`${match[0]} in <${parent.tagName.toLowerCase()}>`);
    }
    return bad;
  }, LATIN_CODE.source);
  if (locale === 'ar') expect.soft(exposed, `${name}: Latin codes outside an LTR isolate`).toEqual([]);
  const fields = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLInputElement>(
        'input[name=code], input[name=ice], input[name=phone], input[name=plate], input[name=date], input[type=date], input[inputmode=numeric], input[inputmode=decimal], input[type=number]',
      ),
    ]
      .filter((el) => el.closest('[dir=ltr]') === null && el.getAttribute('dir') !== 'ltr')
      .map((el) => el.name || el.type),
  );
  if (locale === 'ar') expect.soft(fields, `${name}: code/number inputs without dir="ltr"`).toEqual([]);
}

for (const locale of ['fr', 'ar'] as const) {
  test(`every master-data screen renders correctly in ${locale}`, async ({ page }) => {
    const problems = watch(page);
    const user = locale === 'ar' ? E2E_MD.screensPartnerAr : E2E_MD.screensPartnerFr;
    await loginAndEnrol(page, locale, user.email);

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
