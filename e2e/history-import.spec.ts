import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import {
  decideLabel,
  decideQuarantine,
  type HistoryMapping,
  historyConfirmation,
  listLabels,
  listQuarantine,
  runHistory,
  twinMappings,
  buildTwin,
} from '../src/modules/importer';
import { createPlant, updatePlant } from '../src/modules/master-data';
import { BOOTSTRAP_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { createAuth } from '../src/modules/platform-security/auth/create-auth';
import { createUser } from '../src/modules/platform-security/auth/user-service';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { E2E_BASE_URL, E2E_MD, E2E_PASSWORD, goNav, loginAndEnrol, loginOwner } from './fixtures';
import { checkScreen, watch } from './screen-check';

// T11, end to end on the fictitious twin: the owner stages it, decides a few labels ON THE SCREEN, reads the reconciliation panel, the import is
// applied; then each role signs in and the screens show what that role may see. The importer runs in-process in TRAINING mode (the twin is the
// only file it accepts there); the authenticator step of the CLI is covered by its own tests, here the proof is built as the CLI would.
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const auth = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 1 });
test.afterAll(async () => {
  for (const p of [plantA, plantB]) if (p.id) await updatePlant(app, owner, p.id, { status: 'archived' });
  await Promise.all([migrator.end(), app.end(), auth.end()]);
});
const TRAINING = { trainingMode: true, realData: false, simulationEnabled: false };
const code = () =>
  `H${Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')}`;

let owner: Awaited<ReturnType<typeof realSessionUser>>;
let plantA = { id: '', code: '' };
let plantB = { id: '', code: '' };
let clientId = '';
let month = '';
const set: { dir: string; mapping: HistoryMapping; files: { ord: number; buf: Buffer }[] }[] = [];

test.beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const a = await createPlant(app, owner, { code: code(), name: `Historique A ${randomUUID().slice(0, 6)}` });
  const b = await createPlant(app, owner, { code: code(), name: `Historique B ${randomUUID().slice(0, 6)}` });
  if (!a.ok || !b.ok) throw new Error('plants');
  plantA = { id: a.value.id, code: a.value.code };
  plantB = { id: b.value.id, code: b.value.code };
  const authApi = createAuth({
    authPool: auth,
    env: { ...env, APP_BASE_URL: E2E_BASE_URL },
    log: () => undefined,
  });
  const bootstrap = { userId: BOOTSTRAP_ACTOR_ID, role: 'system' as const };
  for (const [user, role, plantId] of [
    [E2E_MD.histManager, 'plant_manager', plantA.id],
    [E2E_MD.histOffice, 'office_sales', undefined],
    [E2E_MD.histAccountant, 'accountant', undefined],
  ] as const)
    await createUser(authApi, auth, {
      actor: bootstrap,
      ...user,
      password: E2E_PASSWORD,
      role,
      locale: 'fr',
      ...(plantId ? { plantId } : {}),
    });

  // a small twin (the full volumes are covered by the unit tests): the same structure and problems, fewer rows
  const twin = buildTwin({ seed: 7, belgoRows: 64, chaounRows: 36, belgoClients: 10, chaounClients: 5 });
  const maps = twinMappings();
  for (const [dir, key, plantCode] of [
    ['tetouan', 'deliveries-tetouan.json', plantA.code],
    ['chaoun', 'deliveries-chaoun.json', plantB.code],
    ['charges', 'expenses.json', null],
  ] as const) {
    const files = twin
      .filter((f) => f.path.startsWith(`${dir}/`))
      .map((f, i) => ({ ord: i + 1, buf: f.buf }));
    set.push({ dir, mapping: { ...(maps[key] as HistoryMapping), plantCode }, files });
  }
});

const run = (i: number, mode: 'dry-run' | 'stage' | 'apply') =>
  runHistory({
    appPool: app,
    actor: { ...owner, stepUpVerified: true },
    files: set[i]!.files,
    mapping: set[i]!.mapping,
    environment: TRAINING,
    mode,
  });
const apply = async (i: number) => {
  const dry = await run(i, 'dry-run');
  return runHistory({
    appPool: app,
    actor: { ...owner, stepUpVerified: true },
    files: set[i]!.files,
    mapping: set[i]!.mapping,
    environment: TRAINING,
    mode: 'apply',
    stepUp: { userId: owner.id, operation: historyConfirmation(dry.setSha, dry.decisionsSha).operation },
  });
};

test('the owner stages the twin, decides on the screen, reads the reconciliation and the import is applied', async ({
  page,
}) => {
  const problems = watch(page);
  for (const i of [0, 1, 2]) {
    const staged = await run(i, 'stage');
    expect(staged.staged, JSON.stringify(staged.problems)).toBe(true);
  }
  // an apply with open mappings is blocked
  const blocked = await apply(0);
  expect(blocked.applied).toBe(false);
  expect(blocked.blocked.join(' ')).toMatch(/OPEN_MAPPINGS/);

  await loginOwner(page, 'fr');
  await goNav(page, 'history-import-staging-link');
  await expect(page.getByTestId('history-tabs')).toBeVisible();
  // clients: decide the first label ON THE SCREEN (create a new client), the others by the service
  const first = page.getByTestId('history-labels').locator('tbody tr').first();
  await first.locator('select[name=choice]').selectOption('new');
  await first.getByRole('button').click();
  await expect(first).toContainText('À créer');
  // the pump word that is not built in waits for the owner: "P SITRAD"
  await page.goto('/fr/history/staging?tab=pumps&open=1');
  await expect(page.getByTestId('history-labels')).toContainText('P SITRAD');
  const pump = page.getByTestId('history-labels').locator('tbody tr').first();
  await pump.locator('select[name=choice]').selectOption('map:pump');
  await pump.getByRole('button').click();
  await expect
    .poll(async () => {
      await page.goto('/fr/history/staging?tab=pumps&open=1');
      return (
        (await page.getByTestId('history-labels').count()) === 0 ||
        !(await page.getByTestId('history-labels').textContent())?.includes('P SITRAD')
      );
    })
    .toBe(true);
  // a quarantined row (no date): fix it on the screen
  await page.goto('/fr/history/staging?tab=quarantine&open=1');
  const q = page.getByTestId('history-quarantine').locator('tbody tr').first();
  await q.locator('input[name=v_date]').fill('15/03/2026');
  await q.getByRole('button', { name: 'Corriger' }).click();

  // the rest of the decisions, by the service (the owner's own, with the same rules)
  for (const kind of ['client', 'truck', 'driver', 'type', 'pump', 'category'] as const) {
    const { labels } = await listLabels(app, owner, { kind, onlyOpen: true });
    for (const l of labels) {
      const input =
        kind === 'client'
          ? { kind, key: l.key, status: 'new' }
          : kind === 'driver'
            ? { kind, key: l.key, status: 'label_only' }
            : kind === 'pump'
              ? { kind, key: l.key, status: 'mapped', canonical: 'pump' }
              : { kind, key: l.key, status: 'unknown' };
      expect((await decideLabel(app, owner, input)).ok, `${kind} ${l.key}`).toBe(true);
    }
  }
  for (const qr of await listQuarantine(app, owner, { onlyOpen: true })) {
    const values =
      qr.kind === 'deliveries' ? { date: '20/03/2026', m3: '6' } : { date: '20/03/2026', amount: '100' };
    const r = await decideQuarantine(
      app,
      owner,
      { id: qr.id, action: qr.reason === 'NO_AMOUNT' ? 'discard' : 'fix', values },
      { dateFormat: 'dmy', fileMonths: {} },
    );
    expect(r.ok, qr.reason).toBe(true);
  }
  const live0 = await migrator.query<{ s: string; i: string; t: string }>(
    `select (select count(*) from stock_movement) s, (select count(*) from invoice) i, (select count(*) from trip_plan) t`,
  );
  for (const i of [0, 1, 2]) {
    const done = await apply(i);
    expect(done.applied, JSON.stringify(done.blocked)).toBe(true);
  }
  const live1 = await migrator.query<{ s: string; i: string; t: string }>(
    `select (select count(*) from stock_movement) s, (select count(*) from invoice) i, (select count(*) from trip_plan) t`,
  );
  expect(live1.rows[0]).toEqual(live0.rows[0]); // history never touches stock, invoices or trips

  // the reconciliation panel: per plant and month, rows read against imported
  await page.goto('/fr/history/staging?tab=recon');
  await expect(page.getByTestId('history-recon')).toBeVisible();
  const reconRow = page.getByTestId(new RegExp(`history-recon-${plantA.code}-2026-0[3-9]`)).first();
  await expect(reconRow).toContainText('Importé');
  month = (await reconRow.getByRole('cell').nth(2).textContent()) ?? '';
  clientId = (
    await migrator.query<{ client_id: string }>(
      `select client_id from history.delivery d join history.batch b on b.id = d.batch_id where client_id is not null and b.status = 'applied' limit 1`,
    )
  ).rows[0]!.client_id;

  // the history page, labelled, in French and in Arabic; the client statement carries the quantities by month
  await page.goto('/fr/history');
  await expect(page.getByTestId('history-badge')).toContainText('Historique (importé)');
  await expect(page.getByTestId('history-by-month')).toContainText(plantA.code);
  await expect(page.getByTestId('history-expenses')).toBeVisible();
  await page.goto(`/fr/statements/client/${clientId}`);
  await expect(page.getByTestId('history-client-panel')).toContainText('m³');
  await page.goto('/ar/history');
  await checkScreen(page, 'ar', 'history');
  await page.goto('/ar/history/staging?tab=recon');
  await checkScreen(page, 'ar', 'history-staging');
  await page.goto('/fr/analytics');
  await expect(page.getByTestId('analytics-history-link')).toBeVisible();
  expect(problems).toEqual([]);
  expect(month).not.toBe('');
});

test('the plant manager sees his plant only, nothing to decide, no expenses', async ({ browser }) => {
  const p = await (await browser.newContext()).newPage();
  await loginAndEnrol(p, 'fr', E2E_MD.histManager.email);
  await goNav(p, 'history-import-link');
  await expect(p.getByTestId('history-by-month')).toContainText(plantA.code);
  await expect(p.getByTestId('history-by-month')).not.toContainText(plantB.code);
  await expect(p.getByTestId('history-expenses')).toHaveCount(0);
  await expect(p.getByTestId('history-import-staging-link')).toHaveCount(0);
  expect((await p.goto('/fr/history/staging'))?.status()).toBe(404);
  expect((await p.goto(`/fr/statements/client/${clientId}`))?.status()).toBe(404);
  await p.close();
});

test('the sales office sees none of it', async ({ browser }) => {
  const p = await (await browser.newContext()).newPage();
  await loginAndEnrol(p, 'fr', E2E_MD.histOffice.email);
  await expect(p.getByTestId('history-import-link')).toHaveCount(0);
  expect((await p.goto('/fr/history'))?.status()).toBe(404);
  expect((await p.goto('/fr/history/staging'))?.status()).toBe(404);
  await p.close();
});

test('the accountant sees the expense history only', async ({ browser }) => {
  const p = await (await browser.newContext()).newPage();
  await loginAndEnrol(p, 'fr', E2E_MD.histAccountant.email);
  await p.goto('/fr/history');
  await expect(p.getByTestId('history-expenses')).toBeVisible();
  await expect(p.getByTestId('history-by-month')).toHaveCount(0);
  expect((await p.goto('/fr/history/staging'))?.status()).toBe(404);
  await p.close();
});
