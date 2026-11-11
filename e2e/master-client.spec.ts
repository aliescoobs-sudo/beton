import { expect, test } from '@playwright/test';
import { E2E_MD, loginAndEnrol, goNav } from './fixtures';

// Serial: the office test reads the clients the app_admin test creates.
test.describe.configure({ mode: 'serial' });

const ice = `0${Date.now()}`.slice(0, 15).padEnd(15, '7');
const name = `Client E2E ${Date.now()}`;

test('an app_admin creates a client from a name alone, is blocked on a duplicate ICE and overrides with a reason', async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.clientAdminFr.email);
  await goNav(page, 'clients-link');
  await expect(page).toHaveURL('/fr/master-data/clients');

  const form = page.getByTestId('client-new');
  await form.locator('input[name=name]').fill(name);
  await form.locator('button[type=submit]').click();
  await expect(form.getByTestId('client-message')).toHaveText('Enregistré.');
  await expect(page.getByTestId(`client-${name}`)).toContainText('CLT-');

  // Add the ICE through the edit page.
  await page.getByTestId(`client-${name}`).getByRole('link', { name }).click();
  const edit = page.getByTestId('client-edit');
  await edit.locator('select[name=kind]').selectOption('company');
  await edit.locator('input[name=ice]').fill(ice);
  await edit.locator('button[type=submit]').click();
  await expect(edit.getByTestId('client-message')).toHaveText('Enregistré.');

  // A second client on the same ICE is blocked and points at the first; the app_admin can override with a reason.
  await page.goto('/fr/master-data/clients');
  const second = `${name} bis`;
  await form.locator('input[name=name]').fill(second);
  await form.locator('select[name=kind]').selectOption('company');
  await form.locator('summary').click();
  await form.locator('input[name=ice]').fill(ice);
  await form.locator('button[type=submit]').click();
  await expect(form.getByTestId('client-existing')).toContainText(name);
  await form.locator('input[name=iceOverrideReason]').fill('Filiale du même groupe');
  await form.locator('button[type=submit]').click();
  await expect(form.getByTestId('client-message')).toHaveText('Enregistré.');

  // A site is added to the first client from its page.
  await page.goto('/fr/master-data/clients');
  await page.getByTestId(`client-${name}`).getByRole('link', { name }).click();
  await page.getByTestId('site-add').click();
  const site = page.getByTestId('site-new');
  await site.locator('input[name=label]').fill('Chantier Martil');
  await site.locator('input[name=address]').fill('12 rue Hassan II');
  await site.locator('button[type=submit]').click();
  await expect(page.getByTestId('site-message')).toHaveText('Enregistré.');
  await expect(page.getByTestId('site-Chantier Martil')).toContainText('12 rue Hassan II');

  // Archive the second one: it stays listed, flagged.
  await page.goto('/fr/master-data/clients');
  await page.getByTestId(`client-${second}`).getByRole('link', { name: second }).click();
  await expect(page.getByTestId('client-override-reason')).toContainText('Filiale du même groupe');
  await page.getByTestId('client-archive').click();
  await expect(page.getByTestId('client-archived')).toBeVisible();
  await expect(page.getByTestId('client-edit')).toHaveCount(0);
});

test('an office user creates a client but is blocked on a duplicate ICE and cannot archive', async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.clientOffice.email);
  await goNav(page, 'clients-link');
  const form = page.getByTestId('client-new');
  await form.locator('input[name=name]').fill(`${name} bureau`);
  await form.locator('select[name=kind]').selectOption('company');
  await form.locator('summary').click();
  await form.locator('input[name=ice]').fill(ice);
  await form.locator('button[type=submit]').click();
  await expect(form.getByTestId('client-message')).toContainText('Un client porte déjà cet ICE');
  await expect(form.getByTestId('client-existing')).toContainText(name);
  await expect(form.locator('input[name=iceOverrideReason]')).toHaveCount(0);

  await page.goto('/fr/master-data/clients');
  await page.getByTestId(`client-${name}`).getByRole('link', { name }).click();
  await expect(page.getByTestId('client-edit')).toBeVisible();
  await expect(page.getByTestId('client-archive')).toHaveCount(0);
});

test('plant has no clients page (404)', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.clientPlant.email);
  await expect(page.getByTestId('clients-link')).toHaveCount(0);
  // the plant's sales group holds only the order chain (quantities and stages), no client or price page
  await expect(page.getByTestId('selling-prices-link')).toHaveCount(0);
  const response = await page.goto('/fr/master-data/clients');
  expect(response?.status()).toBe(404);
});

test('the clients screen renders right-to-left in Arabic and an app_admin can create a client', async ({
  page,
}) => {
  await loginAndEnrol(page, 'ar', E2E_MD.clientAdminAr.email);
  await goNav(page, 'clients-link');
  await expect(page).toHaveURL('/ar/master-data/clients');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الزبائن');
  const form = page.getByTestId('client-new');
  await form.locator('input[name=name]').fill(`زبون ${Date.now()}`);
  await form.locator('button[type=submit]').click();
  await expect(form.getByTestId('client-message')).toHaveText('تم الحفظ.');
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
