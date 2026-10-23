import { expect, test } from '@playwright/test';
import { E2E_OWNER, E2E_PASSWORD, E2E_PLANT, loginAndEnrol, goNav } from './fixtures';

// Runs in file order (one worker): the plant user enrols first, so the owner can reset its 2FA later.
test.describe.configure({ mode: 'serial' });

test('a non-owner gets a 404 on user admin (T13, SPEC §4)', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_PLANT.email);
  await expect(page.getByTestId('admin-link')).toHaveCount(0);
  const response = await page.goto('/fr/admin/users');
  expect(response?.status()).toBe(404);
  expect((await page.goto('/fr/parameters'))?.status()).toBe(404);
});

test('the owner creates, disables, re-enables a user and resets another user’s 2FA', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_OWNER.email);
  await goNav(page, 'admin-link');
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

  // Parameters (T19): the owner tightens the step-up window, the change persists, then restores the default.
  await page.goto('/fr');
  await goNav(page, 'parameters-link');
  await expect(page).toHaveURL('/fr/parameters');
  const stepUp = page.getByTestId('param-auth.step_up_minutes');
  await stepUp.locator('input[name=value]').fill('8');
  await stepUp.locator('button[type=submit]').click();
  await expect(stepUp.getByTestId('param-message')).toHaveText('Enregistré.');
  await page.reload();
  await expect(page.getByTestId('param-auth.step_up_minutes').locator('input[name=value]')).toHaveValue('8');
  await page.getByTestId('param-auth.step_up_minutes').locator('input[name=value]').fill('10');
  await page.getByTestId('param-auth.step_up_minutes').locator('button[type=submit]').click();
  await expect(page.getByTestId('param-auth.step_up_minutes').getByTestId('param-message')).toHaveText(
    'Enregistré.',
  );

  // Security checklist (T21): the owner marks a manual item with evidence; the banner stays (list incomplete).
  await page.goto('/fr/checklist');
  const csp = page.getByTestId('check-csp_active');
  await expect(csp.getByTestId('status')).toHaveText('À faire');
  await csp.locator('input[name=evidence]').fill('e2e/security-headers.spec.ts');
  await csp.locator('button[type=submit]').click();
  await expect(csp.getByTestId('status')).toHaveText('Fait');
  await expect(page.getByTestId('check-owner_signoff').getByTestId('status')).toHaveText('À faire');
  await expect(page.getByTestId('fake-data-banner')).toBeVisible();

  // Audit viewer (T20): the last parameter change shows its before/after diff.
  await page.goto('/fr/historique?table=parameter&action=update');
  const latest = page.getByTestId('audit-event').first();
  for (const part of ['update', 'parameter', 'auth.step_up_minutes']) {
    await expect(latest.getByTestId('audit-action')).toContainText(part);
  }
  await expect(latest.getByTestId('diff-value')).toContainText('8');
  await expect(latest.getByTestId('diff-value')).toContainText('10');
});

test('a plant user sees only their own actions in the audit viewer (T20)', async ({ page }) => {
  // The owner reset this user's 2FA above, so logging in again goes through enrolment.
  await loginAndEnrol(page, 'fr', E2E_PLANT.email);
  await page.goto('/fr/historique');
  await expect(page.getByText('Vous voyez vos propres actions.')).toBeVisible();
  await expect(page.locator('select[name=person]')).toHaveCount(0);
  const actors = await page.getByTestId('audit-event').locator('span.font-medium').allTextContents();
  expect(actors.length).toBeGreaterThan(0);
  for (const name of actors) expect(['Centrale E2E', 'Système', 'Anonyme']).toContain(name);
});
