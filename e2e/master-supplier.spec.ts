import { expect, test } from '@playwright/test';
import { E2E_MD, loginAndEnrol, goNav } from './fixtures';

test.describe.configure({ mode: 'serial' });

const name = `Fournisseur E2E ${Date.now()}`;

test('office creates a supplier but has no archive button; an app_admin archives it', async ({
  page,
  browser,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.supplierOffice.email);
  await goNav(page, 'suppliers-link');
  await expect(page).toHaveURL('/fr/master-data/suppliers');
  await page.getByTestId('supplier-add').click();
  const form = page.getByTestId('supplier-new');
  await form.locator('input[name=name]').fill(name);
  await form.locator('select[name=category]').selectOption('cement');
  await form.locator('button[type=submit]').click();
  await expect(page.getByTestId('supplier-message')).toHaveText('Enregistré.');
  await expect(page.getByTestId(`supplier-${name}`)).toContainText('FRN-');
  await expect(page.getByTestId('supplier-archive')).toHaveCount(0);

  const app_admin = await browser.newPage();
  await loginAndEnrol(app_admin, 'fr', E2E_MD.supplierAdmin.email);
  await goNav(app_admin, 'suppliers-link');
  await app_admin.getByTestId(`supplier-${name}`).getByTestId('supplier-archive').click();
  await expect(app_admin.getByTestId(`supplier-${name}`).getByTestId('supplier-archived')).toBeVisible();
  await app_admin.close();
});
