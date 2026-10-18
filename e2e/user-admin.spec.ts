import { expect, test } from '@playwright/test';
import { E2E_OWNER, E2E_PASSWORD, E2E_PLANT, loginAndEnrol } from './fixtures';

// Runs in file order (one worker): the plant user enrols first, so the owner can reset its 2FA later.
test.describe.configure({ mode: 'serial' });

test('a non-owner gets a 404 on user admin (T13, SPEC §4)', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_PLANT.email);
  await expect(page.getByTestId('admin-link')).toHaveCount(0);
  const response = await page.goto('/fr/admin/users');
  expect(response?.status()).toBe(404);
});

test('the owner creates, disables, re-enables a user and resets another user’s 2FA', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_OWNER.email);
  await page.getByTestId('admin-link').click();
  await expect(page).toHaveURL('/fr/admin/users');

  // Create (sensitive, but the second factor is fresh right after login: no dialog).
  const email = `e2e-office-${Date.now()}@belgobeton.test`;
  const form = page.getByTestId('create-user');
  await form.locator('input[name=name]').fill('Bureau E2E');
  await form.locator('input[name=email]').fill(email);
  await form.locator('select[name=role]').selectOption('office');
  await form.locator('input[name=password]').fill(E2E_PASSWORD);
  await form.locator('button[type=submit]').click();
  const row = page.getByTestId(`user-${email}`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('status')).toHaveText('Actif');

  // Disable, then re-enable.
  await row.getByRole('button', { name: 'Désactiver' }).click();
  await expect(row.getByTestId('status')).toHaveText('Désactivé');
  await row.getByRole('button', { name: 'Réactiver' }).click();
  await expect(row.getByTestId('status')).toHaveText('Actif');

  // Reset the plant user's 2FA (enrolled in the previous test).
  const plant = page.getByTestId(`user-${E2E_PLANT.email}`);
  await expect(plant.getByTestId('two-factor')).toHaveText('Activée');
  page.once('dialog', (dialog) => void dialog.accept());
  await plant.getByRole('button', { name: 'Réinitialiser la 2FA' }).click();
  await expect(plant.getByTestId('two-factor')).toHaveText('À configurer');
});
