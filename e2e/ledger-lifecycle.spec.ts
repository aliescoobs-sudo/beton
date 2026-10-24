import { expect, type Page, test } from '@playwright/test';
import { goNav, loginOwner, logout } from './fixtures';

// ledger L15: the lifecycle on screen (owner): deposit batch, clear, bounce with its window, regularize, cancel.
test.describe.configure({ mode: 'serial' });

const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
const A = `LCA${suffix}`; // deposited early (written far ahead), then cleared
const B = `LCB${suffix}`; // deposited, bounced, regularized
const D = `LCD${suffix}`; // cancelled
const bankLabel = `Banque cycle ${suffix}`;

async function enter(
  page: Page,
  method: 'cheque' | 'cash',
  amount: string,
  number: string | null,
  written: string | null,
) {
  await page.goto('/fr/payments/new');
  await page.getByTestId('payment-search').fill('Atlas');
  await page.getByTestId('payment-party').selectOption({ index: 1 });
  await page.getByTestId('payment-method').selectOption(method);
  await page.getByTestId('payment-amount').fill(amount);
  if (number) {
    await page.getByTestId('payment-number').fill(number);
    await page.getByTestId('payment-bank').fill('Banque fictive');
    await page.getByTestId('payment-written').fill(written ?? '');
  }
  await page.getByTestId('payment-save').click();
  await expect(page.getByTestId('payment-saved')).toBeVisible();
}

test('the owner runs a cheque through deposit, early clearing, bounce, regularization and cancellation', async ({
  page,
}) => {
  await loginOwner(page, 'fr');

  // A bank account and a caisse to deposit into and to enter cash with.
  await page.goto('/fr/accounts');
  for (const [kind, label] of [
    ['bank', bankLabel],
    ['cash', `Caisse cycle ${suffix}`],
  ] as const) {
    await page.getByTestId('account-add').click();
    await page.getByTestId('account-kind').selectOption(kind);
    await page.getByTestId('account-new').locator('input[name="label"]').fill(label);
    if (kind === 'bank')
      await page.getByTestId('account-new').locator('input[name="bankName"]').fill('Banque fictive');
    await page.getByTestId('account-new').getByRole('button', { name: 'Ajouter un compte' }).click();
    await expect(page.getByTestId(`account-${label}`)).toBeVisible();
  }

  await enter(page, 'cheque', '1 000,00', A, '2099-01-01');
  await enter(page, 'cheque', '2 000,00', B, '2026-01-02');
  await enter(page, 'cheque', '300,00', D, '2099-02-01');

  await goNav(page, 'instruments-link');
  await expect(page.getByTestId(`instrument-${A}`).getByTestId('instrument-state')).toContainText('Reçu');

  // Deposit batch: A and B.
  await page.getByTestId(`batch-pick-${A}`).check();
  await page.getByTestId(`batch-pick-${B}`).check();
  await page.getByTestId('batch-account').selectOption({ label: bankLabel });
  await page.getByTestId('batch-deposit').click();
  await expect(page.getByTestId(`instrument-${A}`).getByTestId('instrument-state')).toContainText(
    'Remis en banque',
  );
  await expect(page.getByTestId(`instrument-${B}`).getByTestId('instrument-state')).toContainText(
    'Remis en banque',
  );
  await expect(page.getByTestId(`instrument-${A}`).getByTestId('instrument-early')).toBeVisible();

  // A is cleared (before the date written on it: flagged, never refused).
  const rowA = page.getByTestId(`actions-${A}`);
  await rowA.getByTestId('action-clear').click();
  await rowA.getByTestId('clear-account').selectOption({ label: bankLabel });
  await rowA.getByTestId('action-confirm').click();
  await expect(page.getByTestId(`instrument-${A}`).getByTestId('instrument-state')).toContainText('Encaissé');

  // B bounces with a bank fee: the 30-day window opens.
  const rowB = page.getByTestId(`actions-${B}`);
  await rowB.getByTestId('action-bounce').click();
  await rowB.getByTestId('bounce-fee').fill('25,00');
  await rowB.getByTestId('action-confirm').click();
  await expect(page.getByTestId(`instrument-${B}`).getByTestId('instrument-state')).toContainText('Rejeté');
  await expect(page.getByTestId(`instrument-${B}`).getByTestId('instrument-countdown')).toContainText(
    '30 jours',
  );

  // A cash payment covers it.
  await enter(page, 'cash', '2 000,00', null, null);
  await page.goto('/fr/instruments');
  const again = page.getByTestId(`actions-${B}`);
  await again.getByTestId('action-regularize').click();
  await again.getByTestId('regularize-cover').selectOption({ index: 1 });
  await again.getByTestId('action-confirm').click();
  await expect(page.getByTestId(`instrument-${B}`).getByTestId('instrument-state')).toContainText(
    'Régularisé',
  );
  await expect(page.getByTestId(`actions-${B}`)).toHaveCount(0);

  // D is cancelled with a reason.
  const rowD = page.getByTestId(`actions-${D}`);
  await rowD.getByTestId('action-cancel').click();
  await rowD.getByTestId('reason').fill('Saisi par erreur');
  await rowD.getByTestId('action-confirm').click();
  await expect(page.getByTestId(`instrument-${D}`).getByTestId('instrument-state')).toContainText('Annulé');
  await logout(page);
});

test('in Arabic the states and the buttons read right-to-left', async ({ page }) => {
  await loginOwner(page, 'ar');
  await page.goto('/ar/instruments');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId(`instrument-${A}`).getByTestId('instrument-state')).toContainText('محصَّل');
  await expect(page.getByTestId(`instrument-${B}`).getByTestId('instrument-state')).toContainText('مسوّى');
});
