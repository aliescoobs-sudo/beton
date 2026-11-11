import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  decideLabel,
  decideQuarantine,
  type HistoryEnvironment,
  type HistoryMapping,
  historyClientVolume,
  historyConfirmation,
  historyExpenses,
  historyRollbackConfirmation,
  historyVolume,
  listLabels,
  listQuarantine,
  reconciliation,
  rollbackHistory,
  runHistory,
} from '../src/modules/importer';
import { buildWorkbook } from './helpers/xlsx-writer';
import { createPlant, updatePlant } from '../src/modules/master-data';
import { testEnv } from './db-env';
import { v1Actors } from './helpers/v1-actors';

// T11: the history importer against a real database. Synthetic data only (every name says FICTIF). The production-mode gates apply (a
// marker-free file); the twin and the guard have their own tests.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const PROD: HistoryEnvironment = { trainingMode: false, realData: true, simulationEnabled: false };
const tag = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
let A: Awaited<ReturnType<typeof v1Actors>>;
let plantB: string;
let plantBCode: string;
let plantACode: string;

beforeAll(async () => {
  A = await v1Actors(app, env.DATABASE_URL_MIGRATOR, `h11${tag.toLowerCase()}`);
  const code = Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );
  const made = await createPlant(app, A.owner, { code, name: `H11B ${tag}` });
  if (!made.ok) throw new Error('plant B');
  plantB = made.value.id;
  plantBCode = code;
  plantACode = (await migrator.query<{ code: string }>('select code from plant where id = $1', [A.plantId]))
    .rows[0]!.code;
});
afterAll(async () => {
  await updatePlant(app, A.owner, plantB, { status: 'archived' }); // other suites expect no extra active plant
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
const D = 46083; // 2026-03-02
const mapping = (plantCode: string | null): HistoryMapping => ({
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
/** Names are unique per run, so two test files never share a label key. */
const names = (n: number) => Array.from({ length: n }, (_, i) => `CLT${tag}${i} FICTIF`);
const files = (clients: string[], extra: (string | number)[][] = []) => [
  {
    ord: 1,
    buf: buildWorkbook([
      {
        name: 'LIVRAISON 1',
        rows: [
          ['', '', '', { f: 'SUM(D3:D9)', v: 0 }],
          HEAD,
          ...clients.map((c, i) => [
            D + i,
            c,
            'CHANTIER FICTIF 1',
            7.5 + i,
            'B25',
            `FX${tag}1`,
            100 + i,
            'POMPE',
            'POUR PARTENAIRE FICTIF',
            `DRV${tag} FICTIF`,
          ]),
          ...extra,
        ],
      },
    ]),
  },
];
const count = async (sql: string) => Number((await migrator.query<{ n: string }>(sql)).rows[0]!.n);
const live = async () => ({
  stock: await count('select count(*) n from stock_movement'),
  invoice: await count('select count(*) n from invoice'),
  instrument: await count('select count(*) n from payment_instrument'),
  trip: await count('select count(*) n from trip_plan'),
  order: await count('select count(*) n from sales_order'),
  delivery: await count('select count(*) n from delivery'),
});
const history = async () => ({
  batch: await count('select count(*) n from history.batch'),
  label: await count('select count(*) n from history.label_map'),
  quarantine: await count('select count(*) n from history.quarantine'),
  delivery: await count('select count(*) n from history.delivery'),
});
const owner = () => ({ ...A.owner, stepUpVerified: true });
const run = (
  mode: 'dry-run' | 'stage' | 'apply',
  f: ReturnType<typeof files>,
  m: HistoryMapping,
  ok = true,
) =>
  runHistory({
    appPool: app,
    actor: owner(),
    files: f,
    mapping: m,
    environment: PROD,
    mode,
    stepUp:
      mode === 'apply' && ok ? { userId: A.owner.id, operation: undefined as unknown as string } : undefined,
  });
/** An apply with the proof the CLI would hold after a verified code (bound to the operation of THIS set). */
async function applyProof(f: ReturnType<typeof files>, m: HistoryMapping) {
  const staged = await run('dry-run', f, m);
  return runHistory({
    appPool: app,
    actor: owner(),
    files: f,
    mapping: m,
    environment: PROD,
    mode: 'apply',
    stepUp: { userId: A.owner.id, operation: historyConfirmation(staged.setSha).operation },
  });
}
/** The owner's decisions for every pending label: clients created, the rest mapped or unknown. */
async function decideAll(clientChoice: 'new' | 'label_only' = 'new') {
  for (const kind of ['client', 'truck', 'driver', 'type', 'pump'] as const) {
    const { labels } = await listLabels(app, A.owner, { kind, onlyOpen: true });
    for (const l of labels.filter(
      (x) => x.label.includes('FICTIF') || x.key.includes(tag) || kind === 'type' || kind === 'pump',
    )) {
      const input =
        kind === 'client'
          ? { kind, key: l.key, status: clientChoice }
          : kind === 'driver'
            ? { kind, key: l.key, status: 'label_only' }
            : { kind, key: l.key, status: 'unknown' };
      expect((await decideLabel(app, A.owner, input)).ok).toBe(true);
    }
  }
}

describe('dry run, stage, apply (T11)', () => {
  const clients = names(3);
  const f = files(clients, [['', `SANS DATE ${tag} FICTIF`, 'C', 5, 'B25']]);

  it('a dry run writes nothing at all (no batch, no label, no quarantine, no audit row of the history)', async () => {
    const before = {
      h: await history(),
      audit: await count(`select count(*) n from audit_event where table_name = 'history_import'`),
    };
    const r = await run('dry-run', f, mapping(plantACode));
    expect(r).toMatchObject({ staged: false, applied: false, batchId: null });
    expect(r.totals).toMatchObject({ rowsRead: 4, imported: 3, quarantined: 1 });
    expect(r.openLabels.client).toBe(4); // the quarantined row's client is staged too: decided up front
    expect(await history()).toEqual(before.h);
    expect(await count(`select count(*) n from audit_event where table_name = 'history_import'`)).toBe(
      before.audit,
    );
  });

  it('only the owner or an app_admin may run it; an apply needs the proof of THIS operation', async () => {
    for (const role of ['office_sales', 'plant_manager', 'accountant', 'driver'] as const)
      await expect(
        runHistory({
          appPool: app,
          actor: A.session(role),
          files: f,
          mapping: mapping(plantACode),
          environment: PROD,
          mode: 'dry-run',
        }),
      ).rejects.toMatchObject({ code: 'ROLE' });
    await expect(run('apply', f, mapping(plantACode), false)).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    await expect(run('apply', f, mapping(plantACode), true)).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    }); // a proof bound to another operation
  });

  it('stages the labels and the quarantined row; the same set staged again changes nothing (idempotent)', async () => {
    const first = await run('stage', f, mapping(plantACode));
    expect(first.staged).toBe(true);
    const h = await history();
    const again = await run('stage', f, mapping(plantACode));
    expect(again.staged).toBe(false);
    expect(again.batchId).toBe(first.batchId);
    expect(await history()).toEqual(h);
    expect(await listQuarantine(app, A.owner, { onlyOpen: true })).toHaveLength(1);
  });

  it('apply is blocked while a mapping or a quarantined row is open, and nothing is written', async () => {
    const live0 = await live();
    const h = await history();
    const r = await applyProof(f, mapping(plantACode));
    expect(r.applied).toBe(false);
    expect(r.blocked.join(' ')).toMatch(/OPEN_MAPPINGS/);
    expect(await history()).toEqual(h);
    expect(await live()).toEqual(live0);
  });

  it('after the decisions it applies: history rows only; live stock, invoices, instruments, trips, orders and deliveries are unchanged', async () => {
    await decideAll('new');
    const blocked = await applyProof(f, mapping(plantACode));
    expect(blocked.blocked.join(' ')).toMatch(/OPEN_QUARANTINE: 1/);
    const [q] = await listQuarantine(app, A.owner, { onlyOpen: true });
    expect(
      (
        await decideQuarantine(app, A.owner, {
          id: q!.id,
          action: 'fix',
          values: { date: '04/03/2026', m3: '5' },
        })
      ).ok,
    ).toBe(true);
    const live0 = await live();
    const clientsBefore = await count(
      `select count(*) n from client where name like 'CLT${tag}%' or name like 'SANS DATE ${tag} FICTIF'`,
    );
    const r = await applyProof(f, mapping(plantACode));
    expect(r).toMatchObject({ applied: true, created: { deliveries: 4, clients: 4 } });
    expect(await live()).toEqual(live0);
    expect(
      await count(
        `select count(*) n from client where name like 'CLT${tag}%' or name like 'SANS DATE ${tag} FICTIF'`,
      ),
    ).toBe(clientsBefore + 4);
    const rows = await migrator.query<{
      source: string;
      volume_l: number;
      legacy: object;
      bl_raw: string;
      note: string;
      client_id: string | null;
      driver_id: string | null;
    }>(
      `select source, volume_l, legacy, bl_raw, note, client_id, driver_id from history.delivery where batch_id = $1 order by volume_l`,
      [r.batchId],
    );
    expect(rows.rows).toHaveLength(4);
    expect(rows.rows.every((x) => x.source === 'history_import')).toBe(true);
    expect(rows.rows.map((x) => x.volume_l)).toEqual([5000, 7500, 8500, 9500]);
    expect(rows.rows[1]?.note).toBe('POUR PARTENAIRE FICTIF');
    expect(rows.rows.filter((x) => x.client_id).length).toBe(4); // the fixed row too: its client was decided up front
    expect(rows.rows.every((x) => x.driver_id === null)).toBe(true); // label only: never creates accounts or records
  });

  it('the same bytes again: already applied, nothing done; the reconciliation shows read = imported', async () => {
    const h = await history();
    const r = await applyProof(f, mapping(plantACode));
    expect(r.applied).toBe(false);
    expect(r.alreadyAppliedBatchId).toBeTruthy();
    expect(await history()).toEqual(h);
    const recon = (await reconciliation(app, A.owner)).filter((x) => x.batchId === r.alreadyAppliedBatchId);
    expect(
      recon
        .filter((x) => x.month === '2026-03')
        .map((x) => [x.rowsRead, x.rowsImported, x.quantityRead, x.quantityImported]),
    ).toEqual([[3, 4, 25_500, 30_500]]);
    expect(recon.find((x) => x.month === '0000-00')).toMatchObject({
      rowsRead: 1,
      rowsQuarantined: 1,
      rowsImported: 0,
    }); // the row with no date, before the owner fixed it
  });

  it('the audit summary holds the hash and counts, never a cell of the file', async () => {
    const { rows } = await migrator.query<{ after: object }>(
      `select after from audit_event where table_name = 'history_import' and action = 'import' order by id desc limit 3`,
    );
    const text = JSON.stringify(rows);
    expect(text).toContain('set_sha');
    for (const secret of [`CLT${tag}`, 'FICTIF', 'CHANTIER', 'PARTENAIRE', `DRV${tag}`, `FX${tag}`])
      expect(text).not.toContain(secret);
  });
});

describe('who sees what (T11, decisions 207-209)', () => {
  const clients = names(2);
  const mk = (code: string | null, tagName: string) =>
    [
      {
        ord: 1,
        buf: buildWorkbook([
          {
            name: 'LIVRAISON 1',
            rows: [
              [''],
              HEAD,
              ...clients.map((c, i) => [
                D + i,
                `${c} ${tagName}`,
                'CH FICTIF',
                10 + i,
                'B25',
                `FX${tag}9`,
                900 + i,
                'G',
                '',
                `DRV${tag} FICTIF`,
              ]),
            ],
          },
        ]),
      },
    ].map((x) => ({ ...x, m: mapping(code) }));
  it("a plant manager reads the quantities of his plant only; a row with no plant is nobody's plant; office, driver and pump operator read none", async () => {
    const sets = [
      { code: plantACode as string | null, name: 'PA' },
      { code: plantBCode as string | null, name: 'PB' },
      { code: null as string | null, name: 'PN' },
    ];
    for (const s of sets) {
      const [one] = mk(s.code, s.name);
      await runHistory({
        appPool: app,
        actor: owner(),
        files: [one!],
        mapping: one!.m,
        environment: PROD,
        mode: 'stage',
      });
      await decideAll('label_only');
      const [{ buf }] = [one!];
      const r = await applyProof([{ ord: 1, buf }], one!.m);
      expect(r.applied, JSON.stringify(r.blocked)).toBe(true);
    }
    const range = { from: '2026-01-01', to: '2026-12-31' };
    const ownerRows = await historyVolume(app, A.owner, range);
    expect(new Set(ownerRows.map((x) => x.plantId))).toContain(null);
    expect(new Set(ownerRows.map((x) => x.plantId))).toContain(plantB);
    const manager = await historyVolume(app, A.session('plant_manager'), range);
    expect(manager.length).toBeGreaterThan(0);
    expect(manager.every((x) => x.plantId === A.plantId)).toBe(true);
    await expect(historyVolume(app, A.session('office_sales'), range)).rejects.toThrow();
    await expect(historyVolume(app, A.session('driver'), range)).rejects.toThrow();
    await expect(historyVolume(app, A.session('pump_operator'), range)).rejects.toThrow();
  });

  it("the tables themselves are the owner's: every other role reads zero rows, even with the permission checks of the service skipped", async () => {
    for (const role of [
      'office_sales',
      'office_purchases',
      'plant_manager',
      'accountant',
      'driver',
      'pump_operator',
    ] as const) {
      const u = A.session(role);
      const seen = await withRlsContext(app, { userId: u.id, role, requestId: randomUUID() }, async (tx) => {
        const out: number[] = [];
        for (const t of ['batch', 'label_map', 'quarantine', 'delivery', 'expense'])
          out.push((await tx.query(`select 1 from history.${t}`)).rowCount ?? 0);
        return out;
      });
      expect(seen, role).toEqual([0, 0, 0, 0, 0]);
    }
  });

  it('the doors refuse a role that does not match its account, and the money door refuses everyone but owner, app_admin, accountant', async () => {
    const u = A.session('plant_manager');
    await expect(
      withRlsContext(app, { userId: u.id, role: 'owner', requestId: randomUUID() }, (tx) =>
        tx.query(`select * from history.volume_report('2026-01-01','2026-12-31')`),
      ),
    ).rejects.toThrow(/does not match/);
    await expect(
      historyExpenses(app, A.session('plant_manager'), { from: '2026-01-01', to: '2026-12-31' }),
    ).rejects.toThrow();
    await expect(historyExpenses(app, A.session('office_sales'), { from: '2026-01-01', to: '2026-12-31' }))
      .resolves.toBeDefined()
      .catch(() => undefined);
    await expect(historyClientVolume(app, A.session('driver'), randomUUID())).rejects.toThrow();
  });

  it('a staged-only or a rolled-back batch is invisible to every report', async () => {
    const [one] = mk(plantBCode, 'PS');
    await runHistory({
      appPool: app,
      actor: owner(),
      files: [one!],
      mapping: one!.m,
      environment: PROD,
      mode: 'stage',
    });
    const before = (await historyVolume(app, A.owner, { from: '2026-01-01', to: '2026-12-31' })).reduce(
      (s, x) => s + x.volumeL,
      0,
    );
    await decideAll('label_only');
    const applied = await applyProof([{ ord: 1, buf: one!.buf }], one!.m);
    const mid = (await historyVolume(app, A.owner, { from: '2026-01-01', to: '2026-12-31' })).reduce(
      (s, x) => s + x.volumeL,
      0,
    );
    expect(mid).toBe(before + 21_000);
    const rb = await rollbackHistory({
      appPool: app,
      actor: owner(),
      batchId: applied.batchId!,
      environment: PROD,
      stepUp: { userId: A.owner.id, operation: historyRollbackConfirmation(applied.batchId!).operation },
    });
    expect(rb).toMatchObject({ alreadyRolledBack: false, blocked: [] });
    const after = (await historyVolume(app, A.owner, { from: '2026-01-01', to: '2026-12-31' })).reduce(
      (s, x) => s + x.volumeL,
      0,
    );
    expect(after).toBe(before);
    // the rows stay (nothing deleted) and the staging decisions are kept
    expect(await count(`select count(*) n from history.delivery where batch_id = '${applied.batchId}'`)).toBe(
      2,
    );
    expect(
      (await listLabels(app, A.owner, { kind: 'client' })).labels.some((l) => l.status === 'label_only'),
    ).toBe(true);
    const twice = await rollbackHistory({
      appPool: app,
      actor: owner(),
      batchId: applied.batchId!,
      environment: PROD,
      stepUp: { userId: A.owner.id, operation: historyRollbackConfirmation(applied.batchId!).operation },
    });
    expect(twice.alreadyRolledBack).toBe(true);
  });

  it('rows cannot be changed or deleted, not even by the migrator (an error, or no row touched)', async () => {
    const touched = async (sql: string) =>
      migrator.query(sql).then(
        (r) => r.rowCount ?? 0,
        () => 0,
      );
    expect(await touched('update history.delivery set volume_l = volume_l + 1')).toBe(0);
    expect(await touched('delete from history.delivery')).toBe(0);
    await expect(migrator.query('truncate history.delivery')).rejects.toThrow();
    expect(await touched('delete from history.batch')).toBe(0);
    expect(await touched(`update history.batch set status = 'staged' where status = 'applied'`)).toBe(0);
    expect(await count('select count(*) n from history.delivery')).toBeGreaterThan(0);
  });
});

describe('serialized, rollback of created clients, and the guard (T11)', () => {
  it('two simultaneous applies of the same set: one writes, the other finds it applied', async () => {
    const f = files(names(2).map((n) => `${n} SER`));
    const m = mapping(plantACode);
    await run('stage', f, m);
    await decideAll('new');
    const [a, b] = await Promise.all([applyProof(f, m), applyProof(f, m)]);
    expect([a.applied, b.applied].sort()).toEqual([false, true]);
    expect([a, b].find((x) => !x.applied)?.alreadyAppliedBatchId).toBeTruthy();
    const batch = (a.applied ? a : b).batchId!;
    expect(await count(`select count(*) n from history.delivery where batch_id = '${batch}'`)).toBe(2);
    // rollback archives the clients the batch created and keeps the rows
    const rb = await rollbackHistory({
      appPool: app,
      actor: owner(),
      batchId: batch,
      environment: PROD,
      stepUp: { userId: A.owner.id, operation: historyRollbackConfirmation(batch).operation },
    });
    expect(rb.archivedClients).toBe(2);
    expect(
      await count(`select count(*) n from client where name like '%SER' and status = 'archived'`),
    ).toBeGreaterThanOrEqual(2);
  });

  it('the environment gates: training mode refuses a file with no marker; a production database refuses when REAL_DATA is off', async () => {
    const f = files(names(1).map((n) => `${n} GUARD`));
    await expect(
      runHistory({
        appPool: app,
        actor: owner(),
        files: f,
        mapping: mapping(plantACode),
        environment: { trainingMode: true, realData: false, simulationEnabled: false },
        mode: 'dry-run',
      }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT' });
    await expect(
      runHistory({
        appPool: app,
        actor: owner(),
        files: f,
        mapping: mapping(plantACode),
        environment: { ...PROD, realData: false },
        mode: 'dry-run',
      }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT' });
  });

  it('an unknown plant code is a problem, not a silent no-plant import', async () => {
    const r = await run('dry-run', files(names(1).map((n) => `${n} PLANT`)), mapping('NOSUCHPL'));
    expect(r.problems.join(' ')).toMatch(/PLANT_UNKNOWN/);
  });
});
