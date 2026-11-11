import { expect, test } from '@playwright/test';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { formatCentimes } from '../src/lib/money';
import {
  createMoneyAccount,
  issueInstrument,
  receiveInstrument,
  setOpeningBalance,
} from '../src/modules/ledger';
import { computeRun, engineParams } from '../src/modules/rules-engine';
import { readParameters } from '../src/modules/platform-security/service/parameter-service';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { E2E_MD, goNav, loginAndEnrol, loginOwner, logout } from './fixtures';

// rules-engine + owner-dashboard: the black day of a small, deterministic scenario, from the data to the confirmed option.
// AC-DASH-01 (AI off, complete), AC-DASH-03 (options write nothing until confirmed), AC-DASH-04 (office and plant: no
// money), AC-DASH-06 (the DOM shows the engine's figures), AC-RE-07 (no duplicate alert on a second visit).
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const auth = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 1 });
test.afterAll(() => Promise.all([migrator.end(), app.end(), auth.end()]));

const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
const businessDate = (plusDays: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(
    new Date(Date.now() + plusDays * 86_400_000),
  );
let chequeInHand = '';
/** The money tables are readable by the owner (RLS), not by the migrator: read them as the owner. */
const asOwner = async <T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> => {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  return withRlsContext(app, { userId: owner.id, role: 'owner', requestId: 'e2e-dashboard' }, fn);
};

/** The list shows the first alerts of each severity and the rest behind a "more" summary: other specs leave alerts of their own. */
const expandAlerts = (page: import('@playwright/test').Page) =>
  page
    .getByTestId('alerts-list')
    .locator('details > summary')
    .evaluateAll((els) => els.forEach((e) => (e as HTMLElement).click()));

test('data: a bank, a cheque we issued for a few days from now, a post-dated cheque in hand', async () => {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const office = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office');
  const supplier = (await migrator.query<{ id: string }>(`select id from supplier order by code limit 1`))
    .rows[0];
  const client = (await migrator.query<{ id: string }>(`select id from client order by code limit 1`))
    .rows[0];
  if (!supplier || !client) throw new Error('master data missing');
  const account = await createMoneyAccount(app, owner, {
    kind: 'bank',
    label: `Banque tableau ${suffix}`,
    bankName: 'Banque fictive',
  });
  if (!account.ok) throw new Error(account.error);
  expect(
    (
      await setOpeningBalance(app, owner, {
        accountId: account.value.id,
        asOf: '2026-01-01',
        amountCentimes: 5_000_000_000, // 50 M MAD: the documents other specs leave open never make an earlier black day
      })
    ).ok,
  ).toBe(true);
  const today = businessDate(0);
  const out = await issueInstrument(
    app,
    owner,
    {
      method: 'cheque',
      amountCentimes: 90_000_000_00,
      number: `DSH${suffix}`,
      bank: 'Banque fictive',
      writtenDate: businessDate(3),
      supplierId: supplier.id,
    },
    { today },
  );
  expect(out.ok, JSON.stringify(out)).toBe(true);
  chequeInHand = `DSI${suffix}`;
  const inn = await receiveInstrument(
    app,
    office,
    {
      method: 'cheque',
      amountCentimes: 120_000_000_00,
      number: chequeInHand,
      bank: 'Banque fictive',
      writtenDate: businessDate(9),
      clientId: client.id,
    },
    { today },
  );
  expect(inn.ok, JSON.stringify(inn)).toBe(true);
});

test("the owner sees the black day, its causes, the forecast and the alerts; the figures are the engine's", async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  await expect(page.getByTestId('owner-today')).toBeVisible();
  await expect(page.getByTestId('black-day')).toBeVisible();
  // The black day is the first deficit of the whole e2e database (earlier specs leave documents of their own): the causes
  // shown are the engine's, whichever documents they are.
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const run = await computeRun(app, owner, businessDate(0), engineParams(await readParameters(auth)));
  const topCause = run.black?.causes[0];
  if (!topCause) throw new Error('no black day');
  await expect(page.getByTestId('black-causes')).toContainText(topCause.code);
  await expect(page.getByTestId('forecast-chart')).toBeVisible();
  await expect(page.getByTestId('alerts-list')).toBeVisible();
  await expandAlerts(page);
  await expect(page.getByTestId('alert-CASH-DEFICIT').first()).toBeVisible();
  await expect(page.getByTestId('brief')).toContainText('Encaissé');

  // AC-DASH-06: the first day shows the engine's balance to the centime.
  const first = run.forecast[0];
  if (!first) throw new Error('no forecast');
  await expect(page.getByTestId(`day-${first.date}`)).toContainText(formatCentimes(first.base));
  await expect(page.getByTestId(`bar-${first.date}`)).toHaveAttribute('data-balance', String(first.base));

  // horizon toggle: 7 working days = 8 columns
  await page.getByTestId('horizon-7').click();
  await expect(page.getByTestId('forecast-days').locator('> li')).toHaveCount(8);
});

test('a second visit stores nothing new; the report ranks the early deposit first and writes nothing until confirmed', async ({
  page,
}) => {
  await loginOwner(page, 'fr');
  const events = () =>
    migrator
      .query<{ n: string }>(`select count(*)::text as n from alert_event`)
      .then((r) => Number(r.rows[0]?.n));
  const before = await events();
  await page.reload();
  await expect(page.getByTestId('owner-today')).toBeVisible();
  expect(await events()).toBe(before); // AC-RE-07

  await expandAlerts(page);
  await page.getByTestId('alert-CASH-DEFICIT').locator('a').first().click();
  await expect(page.getByTestId('alert-report')).toBeVisible();
  await expect(page.getByTestId('report-first')).toContainText('Première détection');
  const first = page.getByTestId('option-1');
  await expect(first).toHaveAttribute('data-option-id', /^DEPOSIT-EARLY:/);
  await expect(first).toHaveAttribute('data-full', 'true');
  await expect(page.getByTestId('opt-1-coverage')).toContainText('100');
  await first.locator('summary').first().click();
  await expect(page.getByTestId('opt-1-whatif')).toBeVisible();

  // viewing and preparing write no decision and deposit nothing (AC-DASH-03)
  const decisions = async () =>
    Number((await asOwner((tx) => tx.query(`select count(*)::text as n from cash_decision`))).rows[0]?.n);
  const deposits = async () =>
    Number(
      (await migrator.query(`select count(*)::text as n from instrument_event where event = 'deposited'`))
        .rows[0]?.n,
    );
  const d0 = await decisions();
  const e0 = await deposits();
  await page.getByTestId('opt-1-prepare').click();
  await expect(page.getByTestId('opt-1-panel')).toContainText("Rien n'est envoyé");
  expect(await decisions()).toBe(d0);
  expect(await deposits()).toBe(e0);

  // confirm: the cheque is deposited and the decision recorded, with its draft message
  await page.getByTestId('opt-1-confirm').click();
  await expect(page.getByTestId('opt-1-done')).toBeVisible();
  expect(await decisions()).toBe(d0 + 1);
  expect(await deposits()).toBe(e0 + 1);
  const row = (
    await asOwner((tx) =>
      tx.query(`select kinds, draft_text, coverage_bp from cash_decision order by created_at desc limit 1`),
    )
  ).rows[0];
  expect(row.kinds).toEqual(['DEPOSIT-EARLY']);
  expect(row.coverage_bp).toBe(10_000);
  expect(row.draft_text).toContain(chequeInHand);
  const state = await migrator.query(
    `select last.event from payment_instrument i cross join lateral (select e.event from instrument_event e where e.instrument_id = i.id order by e.seq desc limit 1) last where i.number = $1`,
    [chequeInHand],
  );
  expect(state.rows[0]?.event).toBe('deposited');
});

test('reclassifying needs a reason and is kept with the computed severity', async ({ page }) => {
  await loginOwner(page, 'fr');
  await expandAlerts(page);
  await page
    .getByTestId('alert-CASH-DEFICIT-WORST')
    .locator('a')
    .first()
    .click()
    .catch(async () => {
      await page.getByTestId('alert-CASH-DEFICIT').locator('a').first().click();
    });
  await expect(page.getByTestId('alert-report')).toBeVisible();
  await page.getByTestId('reclassify-open').click();
  await page.locator('select[name=severity]').selectOption('important');
  await page.getByTestId('reclassify-reason').fill('résolu mais surveillé');
  await page.getByTestId('reclassify-confirm').click();
  await expect(page.getByTestId('alert-report')).toContainText('Reclassé');
  await expect(page.getByTestId('alert-report')).toContainText('résolu mais surveillé');
  const ev = await asOwner((tx) =>
    tx.query(`select kind, severity, override_severity, reason from alert_event where kind = 'reclassified'`),
  );
  expect(ev.rows.length).toBeGreaterThan(0);
  expect(ev.rows[0].override_severity).toBe('important');
});

test('office and plant get a "today" with loads and stock and no money at all; the alert report is a 404 for them', async ({
  page,
}) => {
  for (const email of [E2E_MD.dashOffice.email, E2E_MD.dashPlant.email]) {
    await loginAndEnrol(page, 'fr', email);
    await expect(page.getByTestId('ops-today')).toBeVisible();
    await expect(page.getByTestId('owner-today')).toHaveCount(0);
    const html = await page.content();
    // no formatted amount anywhere (the page carries the label "MAD" in its message catalogue, which is not an amount)
    expect(html).not.toMatch(/\d,\d{2}\s*MAD/);
    expect(html).not.toContain(`DSH${suffix}`);
    const report = await page.goto('/fr/alerts/CASH-DEFICIT%3A2026-01-01');
    expect(report?.status()).toBe(404);
    const cash = await page.goto('/fr/cash');
    expect(cash?.status()).toBe(404);
    await page.goto('/fr');
    await logout(page);
  }
});

test('Arabic: right-to-left, figures left-to-right, the chart and the alerts render', async ({ page }) => {
  await loginOwner(page, 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('owner-today')).toBeVisible();
  await expect(page.getByTestId('forecast-chart')).toBeVisible();
  await expect(page.getByTestId('cash-real').locator('bdi').first()).toHaveAttribute('dir', 'ltr');
  await page.setViewportSize({ width: 360, height: 800 });
  await page.reload();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  void goNav;
});
