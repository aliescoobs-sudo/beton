import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  decideLabel,
  decideQuarantine,
  type HistoryEnvironment,
  type HistoryMapping,
  historyConfirmation,
  historyPurgeConfirmation,
  historyRollbackConfirmation,
  listLabels,
  listQuarantine,
  purgeStaging,
  rollbackHistory,
  runHistory,
} from '../src/modules/importer';
import { createPlant, updatePlant } from '../src/modules/master-data';
import { testEnv } from './db-env';
import { buildWorkbook } from './helpers/xlsx-writer';
import { v1Actors } from './helpers/v1-actors';

/**
 * Gate G3 (retention): `purge-staging` irreversibly clears the label texts/keys and raw quarantine cells of discarded or rolled-back stages — and nothing else.
 * Real staging, a rolled-back set with canaries in a label and in a quarantined cell, an applied set whose mapped client and corrected row are KEPT. Counts only
 * in the audit; owner/app_admin with a fresh second factor; refused while a batch is staged; the same files can be staged again afterwards.
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const PROD: HistoryEnvironment = { trainingMode: false, realData: true, simulationEnabled: false };
const tag = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
let A: Awaited<ReturnType<typeof v1Actors>>;
let plantCode = '';

beforeAll(async () => {
  A = await v1Actors(app, env.DATABASE_URL_MIGRATOR, `g3${tag.toLowerCase()}`);
  plantCode = (await migrator.query<{ code: string }>('select code from plant where id = $1', [A.plantId]))
    .rows[0]!.code;
});
afterAll(async () => {
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
  plant: 'PLANTA',
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
const row = (client: string, m3: number | string, note = 'FICTIF') => [
  46083,
  client,
  'CHANTIER FICTIF 1',
  m3,
  'B25',
  `FX${tag}`,
  Math.floor(Math.random() * 1e6),
  'POMPE',
  note,
  `DRV${tag} FICTIF`,
];
const sheetFile = (rows: (string | number)[][]) => [
  {
    ord: 1,
    buf: buildWorkbook([
      { name: 'LIVRAISON 1', rows: [['', '', '', { f: 'SUM(D3:D9)', v: 0 }], HEAD, ...rows] },
    ]),
  },
];
const owner = () => ({ ...A.owner, stepUpVerified: true });
const stage = (f: ReturnType<typeof sheetFile>) =>
  runHistory({
    appPool: app,
    actor: owner(),
    files: f,
    mapping: mapping(),
    environment: PROD,
    mode: 'stage',
  });
const asOwner = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: A.owner.id, role: 'owner', requestId: tag, stepUp: true }, fn);
const q = async (sql: string, p: unknown[] = []) => asOwner(async (tx) => (await tx.query(sql, p)).rows);
const count = async (sql: string) =>
  Number((await migrator.query<{ n: string }>(`select count(*)::text n from ${sql}`)).rows[0]!.n);
const purge = (stepUp = true) =>
  purgeStaging({
    appPool: app,
    actor: stepUp ? owner() : (A.owner as never),
    environment: PROD,
    stepUp: stepUp ? { userId: A.owner.id, operation: historyPurgeConfirmation.operation } : undefined,
  });

const CANARY_LABEL = `CLTG3${tag} CANARY-LABEL FICTIF`;
const CANARY_CELL = `CANARY-QUARANTINE-CELL-${tag}`;
const KEEP_NEW = `CLTG3${tag} KEEP-NEW FICTIF`;
const DROP_LABEL_ONLY = `CLTG3${tag} DROP-LABEL-ONLY FICTIF`;
const KEEP_FIXED_CELL = `KEPT-FIXED-CELL-${tag}`;

describe('purge-staging: scope, authority, irreversibility', () => {
  let s1: ReturnType<typeof sheetFile>;
  let s2: ReturnType<typeof sheetFile>;
  let appliedBatch = '';
  let keptQuarantineId = '';

  beforeAll(async () => {
    // no other suite's staged batch may stand in the way of this suite's purge (it is refused while one is staged): reverse any left over
    for (const b of (
      await migrator.query<{ id: string }>(`select id from history.batch where status = 'staged'`)
    ).rows)
      await rollbackHistory({
        appPool: app,
        actor: owner(),
        batchId: b.id,
        environment: PROD,
        stepUp: { userId: A.owner.id, operation: historyRollbackConfirmation(b.id).operation },
      });
    // set 1: staged, then rolled back — a label text and a quarantined cell carry canaries
    s1 = sheetFile([row(CANARY_LABEL, 5), row(CANARY_LABEL, '', CANARY_CELL)]);
    const st1 = await stage(s1);
    expect(st1.staged).toBe(true);
    await rollbackHistory({
      appPool: app,
      actor: owner(),
      batchId: st1.batchId!,
      environment: PROD,
      stepUp: { userId: A.owner.id, operation: historyRollbackConfirmation(st1.batchId!).operation },
    });
    // set 2: staged, decided (one client created, one kept as a bare label), a quarantined row corrected, applied
    s2 = sheetFile([row(KEEP_NEW, 6), row(DROP_LABEL_ONLY, 7), row(KEEP_NEW, '', KEEP_FIXED_CELL)]);
    await stage(s2);
    for (const kind of ['client', 'truck', 'driver', 'type', 'pump'] as const) {
      const { labels } = await listLabels(app, A.owner, { kind, onlyOpen: true });
      for (const l of labels.filter(
        (x) =>
          x.key.includes(`G3${tag}`) ||
          x.label.includes('FICTIF') ||
          kind === 'type' ||
          kind === 'pump' ||
          x.key.includes(tag),
      )) {
        const input =
          kind === 'client'
            ? { kind, key: l.key, status: l.label.includes('KEEP-NEW') ? 'new' : 'label_only' }
            : kind === 'driver'
              ? { kind, key: l.key, status: 'label_only' }
              : { kind, key: l.key, status: 'unknown' };
        await decideLabel(app, A.owner, input as never);
      }
    }
    const open = (await listQuarantine(app, A.owner, { onlyOpen: true })).filter(
      (x) => (x.raw.observations ?? '') === KEEP_FIXED_CELL,
    );
    expect(open).toHaveLength(1);
    keptQuarantineId = open[0]!.id;
    expect(
      (await decideQuarantine(app, A.owner, { id: keptQuarantineId, action: 'fix', values: { m3: '4' } })).ok,
    ).toBe(true);
    const dry = await runHistory({
      appPool: app,
      actor: owner(),
      files: s2,
      mapping: mapping(),
      environment: PROD,
      mode: 'dry-run',
    });
    const done = await runHistory({
      appPool: app,
      actor: owner(),
      files: s2,
      mapping: mapping(),
      environment: PROD,
      mode: 'apply',
      stepUp: { userId: A.owner.id, operation: historyConfirmation(dry.setSha, dry.decisionsSha).operation },
    });
    expect(done.applied).toBe(true);
    appliedBatch = done.batchId!;
  });

  it('before the purge the canaries are in the staging (the control)', async () => {
    expect(await count(`history.label_map where label like '%CANARY-LABEL%' and label like '%${tag}%'`)).toBe(
      1,
    );
    expect(await count(`history.quarantine where raw::text like '%${CANARY_CELL}%'`)).toBe(1);
  });

  it('refusals: no second factor, a role that is not owner/app_admin, a direct door call without the step-up, a direct edit of a raw cell', async () => {
    await expect(purge(false)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    for (const role of [
      'office_sales',
      'accountant',
      'plant_manager',
      'driver',
      'support',
      'partner',
    ] as const)
      await expect(
        purgeStaging({
          appPool: app,
          actor: { ...A.session(role), stepUpVerified: true } as never,
          environment: PROD,
          stepUp: { userId: A.ids[role], operation: historyPurgeConfirmation.operation },
        }),
        role,
      ).rejects.toThrow();
    // the door itself, as the owner but WITHOUT the verified step-up, and as a role that may not
    await expect(
      withRlsContext(app, { userId: A.owner.id, role: 'owner', requestId: tag }, (tx) =>
        tx.query('select history.purge_staging()'),
      ),
    ).rejects.toMatchObject({
      code: '42501',
      message: expect.stringContaining('second factor') as unknown as string,
    });
    await expect(
      withRlsContext(
        app,
        { userId: A.ids.accountant, role: 'accountant', requestId: tag, stepUp: true },
        (tx) => tx.query('select history.purge_staging()'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // the cells cannot be wiped (or rewritten) by a direct statement, even by the owner: only the door erases
    await expect(
      asOwner((tx) =>
        tx.query(
          `update history.quarantine set raw = '{}'::jsonb, purged_at = now() where raw::text like '%${CANARY_CELL}%'`,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await count(`history.quarantine where raw::text like '%${CANARY_CELL}%'`)).toBe(1);
  });

  it("the purge clears the rolled-back set (label text and key, raw cells) and the bare labels, keeps the applied set's record and mapped clients, touches no business row, audits counts only", async () => {
    const before = {
      delivery: await count('history.delivery'),
      expense: await count('history.expense'),
      batch: await count('history.batch'),
      client: await count('client'),
      appliedQuarantine: await count(`history.quarantine q where q.raw::text like '%${KEEP_FIXED_CELL}%'`),
    };
    const done = await purge();
    expect(done.quarantineRowsPurged).toBeGreaterThanOrEqual(1); // set 1's unreadable row (its readable row was never a quarantine row)
    expect(done.labelsPurged).toBeGreaterThanOrEqual(1);
    // the canaries are GONE from every table of the history schema, in any column
    for (const t of ['batch', 'label_map', 'quarantine', 'delivery', 'expense'])
      expect(
        await count(`history.${t} x where x::text like '%${CANARY_CELL}%' or x::text like '%CANARY-LABEL%'`),
        t,
      ).toBe(0);
    // the purged rows keep their identity and say so
    expect(
      await count(`history.quarantine where purged_at is not null and raw = '{}'::jsonb and fixed is null`),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await count(
        `history.label_map where purged_at is not null and label = 'purged' and key like 'purged:%'`,
      ),
    ).toBeGreaterThanOrEqual(1);
    // kept: the mapped (created) client and its label text, the applied set's corrected row and its raw cells, the bare label's text is NOT kept
    expect(
      await count(
        `history.label_map where label like '%KEEP-NEW%' and status in ('mapped','new') and purged_at is null`,
      ),
    ).toBe(1);
    expect(await count(`history.label_map where label like '%DROP-LABEL-ONLY%'`)).toBe(0);
    expect(
      await count(`history.quarantine q where q.raw::text like '%${KEEP_FIXED_CELL}%' and purged_at is null`),
    ).toBe(before.appliedQuarantine);
    // no business or history row was touched
    expect({
      delivery: await count('history.delivery'),
      expense: await count('history.expense'),
      batch: await count('history.batch'),
      client: await count('client'),
    }).toEqual({
      delivery: before.delivery,
      expense: before.expense,
      batch: before.batch,
      client: before.client,
    });
    expect(await count(`history.batch where id = '${appliedBatch}' and status = 'applied'`)).toBe(1);
    // the audit holds counts only
    const ev = (
      await migrator.query<{ after: Record<string, unknown>; reason: string }>(
        `select after, reason from audit_event where table_name = 'history_import' and reason = 'history staging purged (counts only)' order by id desc limit 1`,
      )
    ).rows[0]!;
    expect(Object.keys(ev.after).sort()).toEqual(['labels_purged', 'quarantine_rows_purged']);
    expect(JSON.stringify(ev)).not.toContain(CANARY_CELL);
    // idempotent: nothing left to clear
    expect(await purge()).toEqual({ quarantineRowsPurged: 0, labelsPurged: 0 });
  });

  it('refused while a batch is still STAGED; and the purged files can be staged again afterwards, reading their cells afresh', async () => {
    const again = await stage(s1);
    expect(again.staged).toBe(true);
    await expect(purge()).rejects.toThrow(/still staged/);
    expect(
      await count(
        `history.quarantine where raw::text like '%${CANARY_CELL}%' and purged_at is null and status = 'open'`,
      ),
    ).toBe(1);
    // leave the database as found: reverse this stage again and purge it as well
    await rollbackHistory({
      appPool: app,
      actor: owner(),
      batchId: again.batchId!,
      environment: PROD,
      stepUp: { userId: A.owner.id, operation: historyRollbackConfirmation(again.batchId!).operation },
    });
    await purge();
    expect(await count(`history.quarantine x where x::text like '%${CANARY_CELL}%'`)).toBe(0);
    void q;
    void createPlant;
    void updatePlant;
  });
});
