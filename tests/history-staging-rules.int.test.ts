import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  type HistoryEnvironment,
  type HistoryMapping,
  historyRollbackConfirmation,
  historyVolume,
  rollbackHistory,
  runHistory,
} from '../src/modules/importer';
import { buildTwin, twinMappings } from '../src/modules/importer/history/twin';
import { createPlant, updatePlant } from '../src/modules/master-data';
import { testEnv } from './db-env';
import { buildWorkbook } from './helpers/xlsx-writer';
import { v1Actors } from './helpers/v1-actors';

/**
 * R18 group 4B: what `import:history --stage` writes before any second factor. Needs owner/app_admin; every staging write is audited WITHOUT any cell value; a
 * staged batch can be reversed (nothing deleted) and staged again; the other roles read none of it; real files are refused in training mode and twin files in
 * production mode; and none of it reaches live tables, reports or screens. Synthetic data only.
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const PROD: HistoryEnvironment = { trainingMode: false, realData: true, simulationEnabled: false };
const tag = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
let A: Awaited<ReturnType<typeof v1Actors>>;
let plantCode = '';
let plantB = '';

beforeAll(async () => {
  A = await v1Actors(app, env.DATABASE_URL_MIGRATOR, `h4b${tag.toLowerCase()}`);
  plantCode = (await migrator.query<{ code: string }>('select code from plant where id = $1', [A.plantId]))
    .rows[0]!.code;
  const code = Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );
  const made = await createPlant(app, A.owner, { code, name: `H4B ${tag}` });
  if (made.ok) plantB = made.value.id;
});
afterAll(async () => {
  if (plantB) await updatePlant(app, A.owner, plantB, { status: 'archived' });
  await A.done();
  await Promise.all([app.end(), migrator.end()]);
});

const HEAD = [
  'DATE',
  'CLIENTS',
  'CHANTIERS',
  'M3',
  'TYPE',
  'CAMION',
  'B,L',
  'POMPE',
  'OBSERVATIONS',
  'TRANSPORTEUR',
];
const mapping = (): HistoryMapping => ({
  version: 1,
  kind: 'deliveries',
  plant: 'BELGO',
  plantCode,
  sheet: 'LIVRAISON 1',
  headerRow: 2,
  dateFormat: 'dmy',
  columns: { driver: ['TRANSPORTEUR'], truck: ['CAMION'], bl: ['B,L'] },
  legacyColumns: [],
  blankHeaderField: null,
  includeSheets: [],
  fileMonths: {},
});
/** Names unique to this run, so a search of the audit log for a cell can only find THIS file's cells. */
const CELLS = {
  client: `CLTSTAGE${tag} FICTIF`,
  badClient: `CLTQUAR${tag} FICTIF`,
  site: `CHANTIER${tag} FICTIF`,
  driver: `DRVSTAGE${tag} FICTIF`,
  truck: `FXSTAGE${tag}`,
  note: `NOTE${tag} FICTIF`,
};
const files = () => [
  {
    ord: 1,
    buf: buildWorkbook([
      {
        name: 'LIVRAISON 1',
        rows: [
          ['', '', '', { f: 'SUM(D3:D9)', v: 0 }],
          HEAD,
          [46083, CELLS.client, CELLS.site, 7.5, 'B25', CELLS.truck, 101, 'POMPE', CELLS.note, CELLS.driver],
          // no volume: quarantined with its raw cells
          [
            46084,
            CELLS.badClient,
            CELLS.site,
            '',
            'B25',
            CELLS.truck,
            102,
            'POMPE',
            CELLS.note,
            CELLS.driver,
          ],
        ],
      },
    ]),
  },
];
const count = async (sql: string) =>
  Number((await migrator.query<{ n: string }>(`select count(*)::text n from ${sql}`)).rows[0]!.n);
const stage = (actor = A.owner, f = files(), environment: HistoryEnvironment = PROD) =>
  runHistory({
    appPool: app,
    actor: { ...actor, stepUpVerified: true } as never,
    files: f,
    mapping: mapping(),
    environment,
    mode: 'stage',
  });
const live = async () =>
  Promise.all(
    [
      'stock_movement',
      'invoice',
      'payment_instrument',
      'money_movement',
      'delivery',
      'sales_order',
      'trip_plan',
    ].map((t) => count(t)),
  );

describe('B1: who can stage', () => {
  it('only an owner or an app_admin: every other role is refused and nothing is written', async () => {
    const before = [
      await count('history.batch'),
      await count('history.label_map'),
      await count('history.quarantine'),
    ];
    for (const role of [
      'office_sales',
      'office_purchases',
      'plant_manager',
      'accountant',
      'driver',
      'pump_operator',
      'support',
      'partner',
    ] as const) {
      await expect(stage(A.session(role) as never), role).rejects.toThrow();
    }
    expect([
      await count('history.batch'),
      await count('history.label_map'),
      await count('history.quarantine'),
    ]).toEqual(before);
  });
});

describe('B2-B6: a stage by an owner', () => {
  it('writes staging only, audits every write without any cell, hides it from every other role, and changes no live table or report', async () => {
    const live0 = await live();
    const asAdmin = A.session('app_admin') as never;
    const r = await stage(asAdmin);
    expect(r.staged).toBe(true);
    const batch = r.batchId!;
    // --- B6: nothing reached the live tables, and the reports read applied batches only
    expect(await live()).toEqual(live0);
    expect(await count('history.delivery')).toBe(0);
    expect(await historyVolume(app, A.owner, { from: '2026-01-01', to: '2026-12-31' })).toEqual(
      expect.objectContaining({}),
    );
    const volume = await historyVolume(app, A.owner, { from: '2026-01-01', to: '2026-12-31' });
    expect(JSON.stringify(volume)).not.toContain(CELLS.client);
    // --- B2: every staging write is audited, and the audit log holds no cell
    const staged = {
      batch: await count(`history.batch where id = '${batch}'`),
      labels: await count(`history.label_map where label like '%${tag}%'`),
      quarantine: await count(`history.quarantine where set_sha = '${r.setSha}'`),
    };
    expect(staged.batch).toBe(1);
    expect(staged.labels).toBeGreaterThan(0);
    expect(staged.quarantine).toBe(1);
    const audited = await migrator.query<{
      table_name: string;
      before: unknown;
      after: unknown;
      reason: string | null;
    }>(
      `select table_name, "before", "after", reason from audit_event where table_name in ('batch', 'history.label_map', 'history.quarantine', 'history_import')
         and (row_id = $1 or after::text like '%' || $2 || '%' or table_name in ('history.label_map', 'history.quarantine'))
         and at > now() - interval '2 minutes'`,
      [batch, r.setSha],
    );
    const by = (t: string) => audited.rows.filter((x) => x.table_name === t).length;
    expect(by('batch')).toBeGreaterThanOrEqual(1);
    expect(by('history.label_map')).toBeGreaterThanOrEqual(staged.labels);
    expect(by('history.quarantine')).toBeGreaterThanOrEqual(staged.quarantine);
    expect(by('history_import')).toBeGreaterThanOrEqual(1);
    const log = JSON.stringify(audited.rows);
    for (const [what, cell] of Object.entries(CELLS))
      expect(log, `the audit log holds the ${what}`).not.toContain(cell);
    // the whole audit log, not just the rows selected above
    const all = await migrator.query<{ n: string }>(
      `select count(*)::text n from audit_event where table_name like 'history%' and (after::text like $1 or "before"::text like $1)`,
      [`%${tag}%`],
    );
    expect(Number(all.rows[0]!.n)).toBe(0);
    // --- B4: nobody but the owner roles reads any of it
    for (const role of [
      'plant_manager',
      'office_sales',
      'office_purchases',
      'accountant',
      'driver',
      'pump_operator',
      'support',
    ] as const) {
      const u = A.session(role);
      for (const t of ['history.batch', 'history.label_map', 'history.quarantine']) {
        const rows = await withRlsContext(
          app,
          { userId: u.id, role: u.role as never, requestId: 'h4b' },
          (tx) => tx.query(`select 1 from ${t}`),
        ).then(
          (q) => q.rowCount,
          () => 0, // refused outright counts as reading nothing
        );
        expect(rows, `${role} reads ${t}`).toBe(0);
      }
    }
    // --- B3: the stage is reversible by its batch (needs the operation's proof); nothing is deleted
    const owner = { ...A.owner, stepUpVerified: true };
    const tooEarly = await rollbackHistory({
      appPool: app,
      actor: owner,
      batchId: batch,
      environment: PROD,
      stepUp: { userId: A.owner.id, operation: 'history-rollback:wrong' },
    }).then(
      () => 'rolled back',
      (e: Error) => `refused: ${e.message}`,
    );
    expect(tooEarly).toMatch(/^refused/);
    expect(await count(`history.batch where id = '${batch}' and status = 'staged'`)).toBe(1);
    const rows0 = [
      await count('history.label_map'),
      await count('history.quarantine'),
      await count('history.batch'),
    ];
    const rb = await rollbackHistory({
      appPool: app,
      actor: owner,
      batchId: batch,
      environment: PROD,
      stepUp: { userId: A.owner.id, operation: historyRollbackConfirmation(batch).operation },
    });
    expect(rb.blocked).toEqual([]);
    expect(await count(`history.batch where id = '${batch}' and status = 'rolled_back'`)).toBe(1);
    expect(
      await count(
        `history.quarantine where set_sha = '${r.setSha}' and status = 'discarded' and batch_discarded`,
      ),
    ).toBe(1);
    expect([
      await count('history.label_map'),
      await count('history.quarantine'),
      await count('history.batch'),
    ]).toEqual(rows0); // never deleted
    expect(await live()).toEqual(live0);
    // the same files staged again: a new batch, and the quarantined row is OPEN again
    const again = await stage(asAdmin);
    expect(again.staged).toBe(true);
    expect(again.batchId).not.toBe(batch);
    expect(
      await count(
        `history.quarantine where set_sha = '${r.setSha}' and status = 'open' and not batch_discarded`,
      ),
    ).toBe(1);
    expect(await count('history.quarantine')).toBe(rows0[1]!); // no duplicate row
  });
});

describe('B5: the environment decides which files may be staged', () => {
  const twinTetouan = () => [
    { ord: 1, buf: buildTwin({ belgoRows: 12, chaounRows: 12, belgoClients: 3, chaounClients: 2 })[0]!.buf },
  ];
  const twinMapping = (): HistoryMapping => ({
    ...(twinMappings()['deliveries-tetouan.json'] as HistoryMapping),
    plantCode,
  });
  const TRAINING: HistoryEnvironment = { trainingMode: true, realData: false, simulationEnabled: false };
  it('a twin file in production mode, and a real-shaped file in training mode, are refused before anything is staged', async () => {
    const before = [
      await count('history.batch'),
      await count('history.label_map'),
      await count('history.quarantine'),
    ];
    await expect(
      runHistory({
        appPool: app,
        actor: { ...A.owner, stepUpVerified: true } as never,
        files: twinTetouan(),
        mapping: twinMapping(),
        environment: PROD,
        mode: 'stage',
      }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT' });
    await expect(stage(A.owner, files(), TRAINING)).rejects.toMatchObject({ code: 'ENVIRONMENT' });
    expect([
      await count('history.batch'),
      await count('history.label_map'),
      await count('history.quarantine'),
    ]).toEqual(before);
  });
});
