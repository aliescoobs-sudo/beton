import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recreateDatabase, SCENARIO_TEST_DATABASE } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import { formatRollbackReport, type ImportEnvironment, type SheetMapping } from '../src/modules/importer';
import { importWorkbook, rollbackImport } from './helpers/import-proof';
import { withRlsContext } from '../src/lib/db/rls-context';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { buildWorkbook } from './helpers/xlsx-writer';

// R14-10: the soft rollback lists the REAL sealed tables, the opening-date singleton included. It needs a database whose opening date has not
// been entered yet, so it runs on a scratch database of its own (recreated here), not on the shared test database. Synthetic data only.
const env = testEnv(SCENARIO_TEST_DATABASE);
let app: pg.Pool;
let migrator: pg.Pool;
let owner: SessionUser;
const PROD: ImportEnvironment = { trainingMode: false, realData: true, simulationEnabled: false };
const tag = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const map = (sheet: string, kind: SheetMapping['kind']): SheetMapping => ({
  version: 1,
  sheet,
  kind,
  headerRow: 1,
  dateFormat: 'dmy',
  columns: {},
});
const NAME = `Client Fictif Ouverture ${tag}`;

beforeAll(async () => {
  await recreateDatabase(env, SCENARIO_TEST_DATABASE);
  await runMigrations(env.DATABASE_URL_MIGRATOR);
  app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
  migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
  owner = {
    ...(await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner')),
    stepUpVerified: true,
  } as SessionUser;
}, 300_000);
afterAll(async () => {
  await Promise.all([app?.end(), migrator?.end()]);
});

describe('soft rollback after balances were imported (R14-10)', () => {
  it('lists the opening-date singleton and the opening balances as staying, archives the client, and the singleton keeps its date', async () => {
    const file = buildWorkbook([
      {
        name: 'Clients',
        rows: [
          ['Nom', 'Type', 'ICE'],
          [NAME, 'person', ''],
        ],
      },
      {
        name: 'Soldes',
        rows: [
          ['Tiers', 'Code', 'Montant'],
          ['client', NAME, '1 500,00'],
        ],
      },
    ]);
    const done = await importWorkbook({
      appPool: app,
      actor: owner,
      file,
      mappings: [map('Clients', 'clients'), map('Soldes', 'opening_balances')],
      mode: 'apply',
      environment: PROD,
      requireEveryMappedSheet: false,
      openingDate: '2026-02-01',
    });
    expect(done.applied, JSON.stringify(done.sheets.map((s) => s.report.rows))).toBe(true);
    expect((await migrator.query('select opening_date::text d from ledger_opening')).rows).toEqual([
      { d: '2026-02-01' },
    ]);

    const back = await rollbackImport({ appPool: app, actor: owner, runId: done.runId!, environment: PROD });
    expect(back.blocked).toEqual([]);
    expect(back.archived).toMatchObject({ client: 1 });
    // the rows that stay, by their REAL names; nothing unclassified
    expect(back.staysAsRecorded).toEqual({ code_sequence: 1, ledger_opening: 1, opening_party_balance: 1 });
    expect(formatRollbackReport(back)).toMatch(/ledger_opening 1/);

    // what really stayed: the balance and the date (a rollback does not undo the books' opening)
    const asOwner = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
      withRlsContext(app, { userId: owner.id, role: 'owner', requestId: tag }, fn);
    expect(
      (await asOwner((tx) => tx.query('select amount_centimes::text a from opening_party_balance'))).rows,
    ).toEqual([{ a: '150000' }]);
    expect((await migrator.query('select opening_date::text d from ledger_opening')).rows).toEqual([
      { d: '2026-02-01' },
    ]);
    expect((await migrator.query(`select status from client where name = $1`, [NAME])).rows[0]?.status).toBe(
      'archived',
    );
  });

  it('after the rollback, the opening date cannot be re-entered: a new file with another date does not move it', async () => {
    const again = buildWorkbook([
      {
        name: 'Clients',
        rows: [
          ['Nom', 'Type', 'ICE'],
          [`${NAME} bis`, 'person', ''],
        ],
      },
      {
        name: 'Soldes',
        rows: [
          ['Tiers', 'Code', 'Montant'],
          ['client', `${NAME} bis`, '10,00'],
        ],
      },
    ]);
    const r = await importWorkbook({
      appPool: app,
      actor: owner,
      file: again,
      mappings: [map('Clients', 'clients'), map('Soldes', 'opening_balances')],
      mode: 'apply',
      environment: PROD,
      requireEveryMappedSheet: false,
      openingDate: '2026-09-09',
    });
    expect(r.applied).toBe(true);
    expect((await migrator.query('select opening_date::text d from ledger_opening')).rows).toEqual([
      { d: '2026-02-01' },
    ]); // unchanged
  });
});

describe('rollback by an app_admin (R14-10 follow-up)', () => {
  it('a rollback by an app_admin lists the opening balances too', async () => {
    const admin = {
      ...(await realSessionUser(env.DATABASE_URL_MIGRATOR, 'app_admin')),
      stepUpVerified: true,
    } as SessionUser;
    const name = `${NAME} adm`;
    const file = buildWorkbook([
      {
        name: 'Clients',
        rows: [
          ['Nom', 'Type', 'ICE'],
          [name, 'person', ''],
        ],
      },
      {
        name: 'Soldes',
        rows: [
          ['Tiers', 'Code', 'Montant'],
          ['client', name, '20,00'],
        ],
      },
    ]);
    const done = await importWorkbook({
      appPool: app,
      actor: owner,
      file,
      mappings: [map('Clients', 'clients'), map('Soldes', 'opening_balances')],
      mode: 'apply',
      environment: PROD,
      requireEveryMappedSheet: false,
    });
    expect(done.applied).toBe(true);
    const back = await rollbackImport({ appPool: app, actor: admin, runId: done.runId!, environment: PROD });
    expect(back.blocked).toEqual([]);
    expect(back.archived).toMatchObject({ client: 1 });
    // the opening balances are listed for an app_admin too (the code counters are audit rows an app_admin does not read: the inventory of the
    // owner is the complete one, which the operator guide says)
    expect(back.staysAsRecorded).toMatchObject({ opening_party_balance: 1 });
  });
});
