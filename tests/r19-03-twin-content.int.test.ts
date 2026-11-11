import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  decideQuarantine,
  type HistoryEnvironment,
  type HistoryMapping,
  historyRollbackConfirmation,
  rollbackHistory,
  runHistory,
} from '../src/modules/importer';
import { TWIN_MARKER_SHEET, TWIN_MARKER_TEXT } from '../src/modules/importer/history/domain/guard';
import { buildTwin, twinMappings } from '../src/modules/importer/history/twin';
import { testEnv } from './db-env';
import { buildWorkbook } from './helpers/xlsx-writer';
import { v1Actors } from './helpers/v1-actors';

/**
 * R19-03: a marker sheet is not proof that a file is synthetic. A MARKED file with a canary in each retained field (client with the FICTIF word, site,
 * type, pump, truck, driver, delivery note, observation, legacy column, additive; expense label, truck) is refused in training mode before anything is
 * staged; a canary typed as a quarantine correction is refused when typed and again at apply time; the intact twin still stages; an UNMARKED real-looking
 * file is still refused. No write in any refusal.
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const TRAINING: HistoryEnvironment = { trainingMode: true, realData: false, simulationEnabled: false };
const tag = randomUUID().replace(/-/g, '').slice(0, 6);
let A: Awaited<ReturnType<typeof v1Actors>>;
let plantCode = '';

beforeAll(async () => {
  A = await v1Actors(app, env.DATABASE_URL_MIGRATOR, `r3${tag}`);
  plantCode = (await migrator.query<{ code: string }>('select code from plant where id = $1', [A.plantId]))
    .rows[0]!.code;
});
afterAll(async () => {
  await A.done();
  await Promise.all([app.end(), migrator.end()]);
});

/** The owner's own request (the staging tables are FORCE row-level secured: a bare migrator connection sees and changes nothing). */
const asOwner = (sql: string, p: unknown[]) =>
  withRlsContext(app, { userId: A.owner.id, role: 'owner', requestId: tag }, (tx) => tx.query(sql, p));
const count = async (sql: string) =>
  Number((await migrator.query<{ n: string }>(`select count(*)::text n from ${sql}`)).rows[0]!.n);
const counts = async () =>
  Promise.all(['history.batch', 'history.label_map', 'history.quarantine', 'history.delivery'].map(count));

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
  'COMERCIAL',
  'TRANSPORTEUR',
  'ADJUVANT',
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
  legacyColumns: ['COMERCIAL'],
  blankHeaderField: null,
  includeSheets: [],
  fileMonths: {},
});
/** A twin-shaped row; `over` replaces cells by header. */
const row = (over: Record<string, string | number> = {}) => {
  const base: Record<string, string | number> = {
    DATE: 46083,
    CLIENTS: 'KARIMO FICTIF',
    CHANTIERS: 'CHANTIER FICTIF 7',
    M3: 7.5,
    TYPE: 'B25',
    CAMION: 'FX 1004',
    'B,L': 1001,
    POMPE: 'POMPE',
    OBSERVATIONS: '',
    COMERCIAL: 'SAMIR FICTIF',
    TRANSPORTEUR: 'ZINEB FICTIF',
    ADJUVANT: '',
  };
  return HEAD.map((h) => over[h] ?? base[h]!);
};
const marked = (rows: (string | number)[][], opts: { marker?: boolean } = {}) => [
  {
    ord: 1,
    buf: buildWorkbook([
      { name: 'LIVRAISON 1', rows: [['', '', '', { f: 'SUM(D3:D9)', v: 0 }], HEAD, ...rows] },
      ...(opts.marker === false ? [] : [{ name: TWIN_MARKER_SHEET, rows: [[TWIN_MARKER_TEXT]] }]),
    ]),
  },
];
const stage = (f: ReturnType<typeof marked>, environment = TRAINING) =>
  runHistory({
    appPool: app,
    actor: { ...A.owner, stepUpVerified: true } as never,
    files: f,
    mapping: mapping(),
    environment,
    mode: 'stage',
  });

const CANARY = `Dupont-${tag}`;
const CONTAMINATED: [string, Record<string, string | number>][] = [
  ['a client name that carries the FICTIF word but is not a twin name', { CLIENTS: `JEAN ${CANARY} FICTIF` }],
  ['the site', { CHANTIERS: `Rue ${CANARY} 12` }],
  ['the concrete type', { TYPE: `B25 ${CANARY}` }],
  ['the pump', { POMPE: `POMPE ${CANARY}` }],
  ['the truck', { CAMION: `AB-${CANARY}` }],
  ['the driver', { TRANSPORTEUR: `Mehdi ${CANARY}` }],
  ['the delivery note text', { 'B,L': `BL ${CANARY}` }],
  ['the observation', { OBSERVATIONS: `Mme ${CANARY} 0612345678` }],
  ['the legacy column', { COMERCIAL: `Agent ${CANARY}` }],
  ['the additive', { ADJUVANT: `Sika ${CANARY}` }],
];

describe('R19-03: a marked file with real-looking content in a retained field is refused before staging', () => {
  it('the intact twin stages (control)', async () => {
    const r = await stage(
      marked([
        row(),
        row({ CLIENTS: 'MORISA FICTIF 2', OBSERVATIONS: 'POUR LE COMPTE DE PARTENAIRE FICTIF' }),
      ]),
    );
    expect(r.staged).toBe(true);
    const cleanup = await rollbackHistory({
      appPool: app,
      actor: { ...A.owner, stepUpVerified: true } as never,
      batchId: r.batchId!,
      environment: TRAINING,
      stepUp: { userId: A.owner.id, operation: historyRollbackConfirmation(r.batchId!).operation },
    });
    expect(cleanup.blocked).toEqual([]);
  });

  it.each(CONTAMINATED)('%s: refused, nothing written', async (_label, over) => {
    const before = await counts();
    await expect(stage(marked([row(), row(over)]))).rejects.toMatchObject({ code: 'ENVIRONMENT' });
    expect(await counts()).toEqual(before);
  });

  it('a canary in a QUARANTINED row (no volume) is refused as well', async () => {
    const before = await counts();
    await expect(
      stage(marked([row({ M3: '', OBSERVATIONS: `Mme ${CANARY} 0612345678` })])),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT' });
    expect(await counts()).toEqual(before);
  });

  it('an unmarked real-looking file is still refused', async () => {
    const before = await counts();
    await expect(
      stage(marked([row({ CLIENTS: `SOCIETE ${CANARY}` })], { marker: false })),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT' });
    expect(await counts()).toEqual(before);
  });
});

describe('R19-03: a correction typed after staging is validated, when typed and again on the effective values', () => {
  it('a canary in a quarantine correction is refused when typed; one written around that door is refused at the next run; the clean correction passes', async () => {
    const f = marked([row(), row({ M3: '' })]);
    const r = await stage(f);
    expect(r.staged).toBe(true);
    const q = (
      await migrator.query<{ id: string }>(
        `select id from history.quarantine where set_sha = $1 and status = 'open'`,
        [r.setSha],
      )
    ).rows[0]!.id;
    const actor = { ...A.owner, stepUpVerified: true } as never;
    // typed through the door, training mode: refused, nothing changes
    const refused = await decideQuarantine(
      app,
      actor,
      { id: q, action: 'fix', values: { m3: '5', observations: `Mme ${CANARY} 0612` } },
      undefined,
      { trainingMode: true },
    );
    expect(refused).toEqual({ ok: false, error: 'INVALID' });
    expect(await count(`history.quarantine where id = '${q}' and status = 'open'`)).toBe(1);
    // written around the door (as an older build, a script or a hand edit would): the effective value is checked again at the next run
    await asOwner(`update history.quarantine set status = 'fixed', fixed = $2::jsonb where id = $1`, [
      q,
      JSON.stringify({ m3: '5', observations: `Mme ${CANARY} 0612` }),
    ]);
    const before = await counts();
    await expect(stage(f)).rejects.toMatchObject({ code: 'ENVIRONMENT' });
    expect(await counts()).toEqual(before);
    // the clean correction passes the door and the run
    await asOwner(`update history.quarantine set status = 'open', fixed = null where id = $1`, [q]);
    expect(
      await decideQuarantine(app, actor, { id: q, action: 'fix', values: { m3: '5' } }, undefined, {
        trainingMode: true,
      }),
    ).toEqual({ ok: true, value: true });
    const again = await stage(f);
    expect(again.alreadyAppliedBatchId).toBeNull(); // the same set is already staged: the run passes the check and changes nothing
    await rollbackHistory({
      appPool: app,
      actor,
      batchId: r.batchId!,
      environment: TRAINING,
      stepUp: { userId: A.owner.id, operation: historyRollbackConfirmation(r.batchId!).operation },
    });
    await migrator.query(
      `update history.quarantine set status = 'discarded' where set_sha = $1 and status in ('open','fixed')`,
      [r.setSha],
    );
    void buildTwin;
    void twinMappings;
  });
});
