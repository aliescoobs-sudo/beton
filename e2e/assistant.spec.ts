import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { formatCentimes } from '../src/lib/money';
import { readFileSync, writeFileSync } from 'node:fs';
import { getInvoiceQueue } from '../src/modules/ledger';
import { addDaysIso } from '../src/modules/ledger';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import {
  clientWithLoads,
  deliveryScene,
  type DeliveryScene,
  orderMaster,
} from '../tests/helpers/ledger-fixtures';
import {
  E2E_MD,
  E2E_OFF_URL,
  loginAndEnrol,
  loginOwner,
  msUntilNextStep,
  totpFromDisplayedKey,
} from './fixtures';

// assistant A8 (SPEC-assistant §1, §7; AC-ASSIST-01, 17, 19, 20, 28, 29): the panel from every screen, in French and Arabic, at 375 and
// 1280 px, with the Fake provider, and the endpoints with the flag off.
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
test.afterAll(() => Promise.all([migrator.end(), app.end()]));

// The business date of the server (real time, Casablanca). No digit in the marker: labels are built from it, and a run of six
// digits in a payload is a leak by rule.
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Africa/Casablanca' });
const marker = `e2eas${randomUUID()
  .replace(/-/g, '')
  .slice(0, 8)
  .replace(/\d/g, (d) => 'ghijklmnop'[Number(d)] as string)}`;
const MONEY = /MAD|DH|\d\s?\d{3},\d{2}/;
let scene: DeliveryScene;
let officeClient = { code: '', blNos: [] as string[] };
let ownerClient = { code: '', blNos: [] as string[], deliveryIds: [] as string[] };

test.beforeAll(async () => {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  // An order far ahead: it must not appear on today's dispatch board, which the dispatch specs of this shared database read.
  scene = await deliveryScene(app, owner.id, marker, addDaysIso(today, 30));
  // The fixture names a client and a product the same; here they differ.
  const master = await orderMaster(app, owner.id, marker);
  await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
    tx.query('update client set name = $2 where id = $1', [master.clientId, `mc${marker}`]),
  );
  const a = await clientWithLoads(app, owner.id, master, scene, [[3000, 2000]]);
  officeClient = { code: a.clientCode, blNos: a.orders[0]!.blNos };
  const b = await clientWithLoads(app, owner.id, master, scene, [[4000, 1500]]);
  ownerClient = { code: b.clientCode, blNos: b.orders[0]!.blNos, deliveryIds: b.orders[0]!.deliveryIds };
});

const watch = (page: Page) => {
  const problems: string[] = [];
  page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(String(e)));
  return problems;
};

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function ask(page: Page, question: string) {
  const before = await page.getByTestId('assistant-answer-block').count();
  await page.getByTestId('assistant-input').fill(question);
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('assistant-answer-block')).toHaveCount(before + 1);
  return page.getByTestId('assistant-answer-block').last();
}

/** Confirms the draft; if the second factor is asked, answers it as an authenticator app would. */
async function confirm(page: Page, key: string) {
  await page.getByTestId('draft-confirm').click();
  const dialog = page
    .getByRole('dialog', { name: /vérification|code|رمز/i })
    .filter({ has: page.locator('input[name=code]') });
  if (await dialog.isVisible({ timeout: 1500 }).catch(() => false)) {
    await page.waitForTimeout(msUntilNextStep());
    await dialog.locator('input[name=code]').fill(await totpFromDisplayedKey(key));
    await dialog.locator('button[type=submit]').click();
  }
}

test('plant: the button is in the top bar, the questions suit the role, the answer shows its tools and what was sent', async ({
  page,
}) => {
  const problems = watch(page);
  await loginAndEnrol(page, 'fr', E2E_MD.astPlant.email);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId('assistant-open').click();
  await expect(page.getByTestId('assistant-panel')).toBeVisible();
  await expect(page.locator('[data-testid^=assistant-suggestion-]')).toHaveCount(4);
  const block = await ask(page, 'Quel est le prochain chargement ?');
  await expect(block.getByTestId('assistant-answer')).toContainText(/chargement/i);
  await expect(block.getByTestId('assistant-chip').first()).toHaveAttribute('data-tool', 'next_load');
  // What was sent: codes, never names; and the plant reads no money.
  await block.getByTestId('assistant-sent').locator('summary').click();
  const sent = (await block.getByTestId('assistant-sent-payload').textContent()) ?? '';
  expect(sent).toContain('next_load');
  expect(sent).not.toContain(`dl${marker}`);
  expect(sent).not.toContain(`mc${marker}`);
  expect(await page.getByTestId('assistant-panel').textContent()).not.toMatch(MONEY);
  // The same at 375 px.
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await noOverflow(page)).toBe(true);
  const box = await page.getByTestId('assistant-panel').boundingBox();
  expect(box?.width).toBeLessThanOrEqual(375);
  await page.getByTestId('assistant-close').click();
  await expect(page.getByTestId('assistant-panel')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('office, blind: BL to invoice without a figure, a draft of the invoice without a figure, confirmed to an invoice number only', async ({
  page,
}) => {
  const problems = watch(page);
  const key = await loginAndEnrol(page, 'fr', E2E_MD.astOffice.email);
  await page.getByTestId('assistant-open').click();
  const listed = await ask(page, 'Quels BL ne sont pas encore facturés ?');
  await expect(listed.getByTestId('assistant-answer')).toContainText(officeClient.blNos[0]!);
  await expect(listed.getByTestId('assistant-chip').first()).toHaveAttribute('data-tool', 'uninvoiced_bls');
  const drafted = await ask(page, `Facture ces BL ${officeClient.blNos.join(' ')} pour ${officeClient.code}`);
  const card = drafted.getByTestId('draft-card-invoice_from_bls');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('draft-blind')).toBeVisible();
  await expect(card.getByTestId('draft-row')).toHaveCount(2);
  for (const bl of officeClient.blNos) await expect(card).toContainText(bl);
  expect(await page.getByTestId('assistant-panel').textContent()).not.toMatch(MONEY);
  // Nothing is created before the click.
  const before = (
    await migrator.query<{ n: string }>(
      `select count(*)::text as n from invoice where client_id = (select id from client where code = $1)`,
      [officeClient.code],
    )
  ).rows[0]!.n;
  expect(before).toBe('0');
  await confirm(page, key);
  await expect(card.getByTestId('draft-status')).toHaveText('Confirmé');
  await expect(card.getByTestId('draft-result')).toContainText('FA-');
  expect(await page.getByTestId('assistant-panel').textContent()).not.toMatch(MONEY);
  const made = await migrator.query<{ number: string; n: string }>(
    `select i.number, (select count(*)::text from invoice_line l where l.invoice_id = i.id) as n from invoice i
      where i.client_id = (select id from client where code = $1) and i.credit_note_of is null`,
    [officeClient.code],
  );
  expect(made.rows).toHaveLength(1);
  expect(made.rows[0]?.n).toBe('2');
  // The audit trail says who and how.
  const audit = await migrator.query(
    `select 1 from audit_event where actor_kind = 'ai_confirmed' and table_name = 'invoice'`,
  );
  expect(audit.rowCount).toBeGreaterThan(0);
  // A money question office has no tool for: it is told so, with no figure.
  const refused = await ask(page, 'Quelles factures sont impayées ?');
  await expect(refused.getByTestId('assistant-answer')).toContainText('Je ne peux pas répondre');
  expect(await page.getByTestId('assistant-panel').textContent()).not.toMatch(MONEY);
  expect(problems).toEqual([]);
});

test('owner: the figures are the stored ones, the draft shows the invoice as the database makes it, and the unpaid list shows it', async ({
  page,
}) => {
  const problems = watch(page);
  await loginOwner(page, 'fr');
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const queue = (await getInvoiceQueue(app, owner)).find((c) => c.clientCode === ownerClient.code)!;
  await page.getByTestId('assistant-open').click();
  await expect(page.locator('[data-testid^=assistant-suggestion-]')).toHaveCount(5);
  const listed = await ask(page, `Qu'est-ce qu'il reste à facturer pour ${ownerClient.code} ?`);
  await expect(listed.getByTestId('assistant-answer')).toContainText(
    `${formatCentimes(queue.money!.ttcCentimes)} MAD`,
  );
  const drafted = await ask(page, `Facture ces BL ${ownerClient.blNos.join(' ')} pour ${ownerClient.code}`);
  const card = drafted.getByTestId('draft-card-invoice_from_bls');
  await expect(card.getByTestId('draft-field-totalTtc')).toContainText(
    `${formatCentimes(queue.money!.ttcCentimes)} MAD`,
  );
  await expect(card.getByTestId('draft-field-advance')).toBeVisible();
  await expect(card.getByTestId('draft-field-netToPay')).toBeVisible();
  const ownerKey = (JSON.parse(readFileSync('test-results/e2e-owner-totp.json', 'utf8')) as { key: string })
    .key;
  await confirm(page, ownerKey);
  // If the code was asked, it used a 30-second step: the next owner sign-in must not reuse it.
  writeFileSync(
    'test-results/e2e-owner-totp.json',
    JSON.stringify({ key: ownerKey, step: Math.floor(Date.now() / 30_000) }),
  );
  await expect(card.getByTestId('draft-status')).toHaveText('Confirmé');
  const number = (await card.getByTestId('draft-result').textContent())?.match(/FA-\d{4}-\d{5,}/)?.[0] ?? '';
  expect(number).not.toBe('');
  const stored = await migrator.query<{ total: string }>(
    'select total_ttc_centimes::text as total from invoice where number = $1',
    [number],
  );
  expect(`${formatCentimes(Number(stored.rows[0]!.total))} MAD`).toBe(
    `${formatCentimes(queue.money!.ttcCentimes)} MAD`,
  );
  // The unpaid list now carries it, with the stored amount.
  const unpaid = await ask(page, `Quelles factures sont impayées pour ${ownerClient.code} ?`);
  await expect(unpaid.getByTestId('assistant-answer')).toContainText(number);
  await expect(unpaid.getByTestId('assistant-answer')).toContainText(
    `${formatCentimes(Number(stored.rows[0]!.total))} MAD`,
  );
  expect(problems).toEqual([]);
});

test('office in Arabic: right to left, Darija understood, codes isolated, 375 and 1280 px', async ({
  page,
}) => {
  const problems = watch(page);
  await loginAndEnrol(page, 'ar', E2E_MD.astOfficeAr.email);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByTestId('assistant-open').click();
  await expect(page.getByTestId('assistant-panel')).toBeVisible();
  await expect(page.getByTestId('assistant-suggestion-1')).toContainText('السندات');
  expect(await noOverflow(page)).toBe(true);
  await page.getByTestId('assistant-suggestion-3').click();
  const block = page.getByTestId('assistant-answer-block').last();
  await expect(block).toBeVisible();
  await expect(block.getByTestId('assistant-chip').first()).toBeVisible();
  // A Darija question about what is not invoiced yet; a code in the answer is its own left-to-right island.
  await page.getByTestId('assistant-input').fill('أي السندات ما تفوترش بعد؟');
  await page.getByTestId('assistant-send').click();
  const answer = page.getByTestId('assistant-answer').last();
  await expect(answer).toContainText('سند');
  await expect(answer.locator('bdi[dir=ltr]').first()).toBeVisible();
  expect(await page.getByTestId('assistant-panel').textContent()).not.toMatch(MONEY);
  expect(await noOverflow(page)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(await noOverflow(page)).toBe(true);
  expect(problems).toEqual([]);
});

test('support reads and drafts nothing; partner has the operations questions', async ({ page }) => {
  await loginAndEnrol(page, 'fr', E2E_MD.astSupport.email);
  await page.getByTestId('assistant-open').click();
  await expect(page.locator('[data-testid^=assistant-suggestion-]')).toHaveCount(3);
  const block = await ask(page, `Facture ces BL ${officeClient.blNos.join(' ')} pour ${officeClient.code}`);
  await expect(block.getByTestId('draft-confirm')).toHaveCount(0);
  await expect(page.locator('[data-testid^=draft-card-]')).toHaveCount(0);
});

test('partner (no account in V1, T8): the rotation questions are refused, no money, no draft', async ({
  page,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.astPartner.email);
  await page.getByTestId('assistant-open').click();
  await expect(page.locator('[data-testid^=assistant-suggestion-]')).toHaveCount(3);
  const block = await ask(page, "Quels camions chargent aujourd'hui ?");
  await expect(block.getByTestId('assistant-answer')).toContainText('avec vos droits');
  await expect(block.getByTestId('assistant-answer')).not.toContainText('rotation');
  expect(await page.getByTestId('assistant-panel').textContent()).not.toMatch(MONEY);
});

test.describe('with the flag off (AC-ASSIST-01)', () => {
  test.use({ baseURL: E2E_OFF_URL });

  test('there is no entry in the top bar, and every endpoint answers 404', async ({ page }) => {
    await loginAndEnrol(page, 'fr', E2E_MD.astOff.email);
    await expect(page.getByTestId('user-menu')).toBeVisible();
    await expect(page.getByTestId('assistant-open')).toHaveCount(0);
    const headers = { origin: E2E_OFF_URL, 'content-type': 'application/json' };
    const ask = await page.request.post(`${E2E_OFF_URL}/api/assistant/ask`, {
      headers,
      data: { question: 'Bonjour' },
    });
    expect(ask.status()).toBe(404);
    expect((await page.request.get(`${E2E_OFF_URL}/api/assistant/proposals`)).status()).toBe(404);
    const id = randomUUID();
    expect(
      (
        await page.request.post(`${E2E_OFF_URL}/api/assistant/proposals/${id}/confirm`, { headers, data: {} })
      ).status(),
    ).toBe(404);
    expect(
      (
        await page.request.post(`${E2E_OFF_URL}/api/assistant/proposals/${id}/reject`, { headers, data: {} })
      ).status(),
    ).toBe(404);
  });
});

test.describe('with the flag on, the door is closed to strangers', () => {
  test('a post from another origin is refused, an unsigned one is refused', async ({ page, request }) => {
    const unsigned = await request.post('/api/assistant/ask', {
      headers: { origin: 'http://localhost:3100' },
      data: { question: 'Bonjour' },
    });
    expect([401, 404]).toContain(unsigned.status());
    await loginAndEnrol(page, 'fr', E2E_MD.astPlantAr.email);
    const foreign = await page.request.post('/api/assistant/ask', {
      headers: { origin: 'http://evil.example' },
      data: { question: 'Bonjour' },
    });
    expect(foreign.status()).toBe(403);
    const noOrigin = await page.request.post('/api/assistant/ask', { data: { question: 'Bonjour' } });
    expect(noOrigin.status()).toBe(403);
  });
});
