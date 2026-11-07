import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatWorkbookReport,
  type ImportEnvironment,
  ImportRefused,
  type SheetMapping,
  type WorkbookReport,
} from '../src/modules/importer';
import { importWorkbook, rollbackImport } from './helpers/import-proof';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { buildWorkbook } from './helpers/xlsx-writer';

// T2: a whole workbook in one transaction. Synthetic data only (obviously fake names, ICE, phones).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));
const PROD: ImportEnvironment = { trainingMode: false, realData: true, simulationEnabled: false };
let owner: SessionUser;
let stepped: SessionUser;
const tag = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const fakeIce = () => String(Math.floor(Math.random() * 9e14) + 1e14);
const CLIENT_ICE = fakeIce(); // one ICE for the run's client: a repeat of the row must say the same thing (R14-08)
const map = (sheet: string, kind: SheetMapping['kind']): SheetMapping => ({
  version: 1,
  sheet,
  kind,
  headerRow: 1,
  dateFormat: 'dmy',
  columns: {},
});
const MAPPINGS = [
  map('Types', 'concrete_types'),
  map('Composants', 'components'),
  map('Recettes', 'recipes'),
  map('Clients', 'clients'),
  map('Fournisseurs', 'suppliers'),
  map('Prix', 'selling_prices'),
  map('Soldes', 'opening_balances'),
  map('Cheques', 'cheques_in_transit'),
  map('Facture', 'invoice_sequence'),
];
const T = `W${tag}`.slice(0, 7);
const CLIENT = `Client Fictif ${tag}`;
const year = 2500 + Math.floor(Math.random() * 400);
const sheets = (over: Partial<Record<string, (string | number)[][]>> = {}) =>
  [
    {
      name: 'Types',
      rows: [
        ['Code', 'Libellé'],
        [T, `Béton fictif ${tag}`],
      ],
    },
    {
      name: 'Composants',
      rows: [
        ['Nom', 'Unité'],
        [`Ciment Fictif ${tag}`, 'g'],
      ],
    },
    {
      name: 'Recettes',
      rows: [
        ['Type', 'Composant', 'Quantité', 'Unité', 'Date'],
        [T, `Ciment Fictif ${tag}`, '350', 'kg', '01/12/2026'],
      ],
    },
    {
      name: 'Clients',
      rows: [
        ['Nom', 'Type', 'ICE', 'Téléphone'],
        [CLIENT, 'company', CLIENT_ICE, '0600000000'],
      ],
    },
    {
      name: 'Fournisseurs',
      rows: [
        ['Nom', 'Catégorie'],
        [`Fournisseur Fictif ${tag}`, 'aggregates'],
      ],
    },
    {
      name: 'Prix',
      rows: [
        ['Type', 'Prix', 'Date'],
        [T, '700,50', '01/12/2026'],
      ],
    },
    {
      name: 'Soldes',
      rows: [
        ['Tiers', 'Code', 'Montant'],
        ['client', CLIENT, '1 000,25'],
      ],
    },
    {
      name: 'Cheques',
      rows: [
        ['Client', 'Type', 'Numéro', 'Banque', 'Montant', 'Date'],
        [CLIENT, 'chèque', `FAKE${tag}1`, 'Banque Fictive', '12 500,00', '15/10/2026'],
      ],
    },
    {
      name: 'Facture',
      rows: [
        ['Année', 'Dernier numéro'],
        [year, 42],
      ],
    },
  ].map((s) => ({ ...s, rows: over[s.name] ?? s.rows }));
const file = (over: Partial<Record<string, (string | number)[][]>> = {}) => buildWorkbook(sheets(over));
const run = (buf: Buffer, mode: 'dry-run' | 'apply', actor = stepped, environment = PROD) =>
  importWorkbook({
    appPool: app,
    actor,
    file: buf,
    mappings: MAPPINGS,
    mode,
    environment,
    openingDate: '2026-01-01',
  });
const count = async (table: string, where = 'true') =>
  Number(
    (await migrator.query<{ n: string }>(`select count(*)::text as n from ${table} where ${where}`)).rows[0]
      ?.n,
  );

beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  stepped = { ...owner, stepUpVerified: true };
});

describe('refusals before anything is read', () => {
  it('refuses on the training instance, a simulated database and a non-REAL_DATA instance, for a dry run too', async () => {
    for (const bad of [
      { ...PROD, trainingMode: true },
      { ...PROD, simulationEnabled: true },
      { ...PROD, realData: false },
    ])
      for (const mode of ['dry-run', 'apply'] as const)
        await expect(run(file(), mode, stepped, bad)).rejects.toMatchObject({ code: 'ENVIRONMENT' });
    expect(await count('client', `name = '${CLIENT}'`)).toBe(0);
  });
  it('an apply needs the step-up; an office account may not import at all', async () => {
    await expect(run(file(), 'apply', owner)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const office = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office_sales');
    await expect(run(file(), 'dry-run', { ...office, stepUpVerified: true })).rejects.toBeInstanceOf(
      ImportRefused,
    );
    expect(await count('client', `name = '${CLIENT}'`)).toBe(0);
  });
});

describe('the dry run', () => {
  it('validates sheets that depend on each other, reports, and leaves the database and the audit trail untouched', async () => {
    const before = [
      await count('client'),
      await count('concrete_type'),
      await count('selling_price'),
      await count('audit_event'),
    ];
    const r = await run(file(), 'dry-run');
    expect(r.applied).toBe(false);
    expect(r.fileProblems).toEqual([]);
    expect(r.totals).toMatchObject({ error: 0, failed: 0 });
    expect(r.sheets.map((s) => s.kind)).toEqual([
      'concrete_types',
      'components',
      'recipes',
      'clients',
      'suppliers',
      'selling_prices',
      'opening_balances',
      'cheques_in_transit',
      'invoice_sequence',
    ]);
    const after = [
      await count('client'),
      await count('concrete_type'),
      await count('selling_price'),
      await count('audit_event'),
    ];
    expect(after).toEqual(before);
    expect(await count('client', `name = '${CLIENT}'`)).toBe(0);
  });
  it('lists every problem with its sheet and row, and none of the cells', async () => {
    const r = await run(
      file({
        Prix: [
          ['Type', 'Prix', 'Date'],
          [T, '1,234', '01/12/2026'],
          [T, '700', '31/02/2026'],
        ],
        Clients: [
          ['Nom', 'Type', 'ICE'],
          [CLIENT, 'company', '123'],
        ],
      }),
      'dry-run',
    );
    const text = formatWorkbookReport(r);
    expect(text).toMatch(/\[Sheet \d+\] selling_prices/); // by position (R14-09)
    expect(text).toMatch(/row 2: price in MAD HT per m³: ambiguous amount/);
    expect(text).toMatch(/row 3: date not understood or ambiguous/);
    expect(text).toMatch(/\[Sheet \d+\] clients[^\n]*\n\s+row 2: invalid row/);
    expect(text).not.toContain(CLIENT);
    expect(text).toContain(r.sha256);
  });
  it('says so when a mapped sheet is missing from the file and lists a sheet nobody mapped', async () => {
    const buf = buildWorkbook([...sheets().slice(0, 2), { name: 'Notes', rows: [['x']] }]);
    const r = await run(buf, 'dry-run');
    expect(r.unmappedSheets).toEqual(['Sheet 3']); // by position, never by the name the file gave it (R14-09)
    expect(r.fileProblems.some((p) => p.includes('(kind recipes) matches no sheet'))).toBe(true);
    // the built-in defaults name every kind: a workbook with only some of them is not a problem
    const lax = await importWorkbook({
      appPool: app,
      actor: stepped,
      file: buf,
      mappings: MAPPINGS,
      mode: 'dry-run',
      environment: PROD,
      requireEveryMappedSheet: false,
    });
    expect(lax.fileProblems).toEqual([]);
  });
});

describe('the real run', () => {
  let first: WorkbookReport;
  const buf = file();
  it('writes everything in one transaction and audits it with the file hash, never its contents', async () => {
    first = await run(buf, 'apply');
    expect(first.applied).toBe(true);
    expect(first.totals).toMatchObject({ error: 0, failed: 0 });
    expect(await count('client', `name = '${CLIENT}'`)).toBe(1);
    expect(await count('concrete_type', `code = '${T}'`)).toBe(1);
    expect(await count('payment_instrument', `number = 'FAKE${tag}1'`)).toBe(1);
    const events = await migrator.query<{ after: Record<string, unknown>; actor_user_id: string }>(
      `select after, actor_user_id from audit_event where action = 'import' and row_id = $1`,
      [first.runId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.actor_user_id).toBe(owner.id);
    expect(events.rows[0]?.after).toMatchObject({ sha256: first.sha256, size_bytes: buf.length });
    const text = JSON.stringify(events.rows[0]?.after);
    for (const secret of [CLIENT, 'Banque Fictive', `FAKE${tag}1`, '0600000000'])
      expect(text).not.toContain(secret);
    // every row of the run is findable by the run's tag (what the rollback reads)
    expect(
      await count('audit_event', `request_id like 'import:${first.runId}|%' and action = 'insert'`),
    ).toBeGreaterThan(8);
  });
  it('is idempotent: the same bytes do nothing; a changed file skips what exists and adds what is new', async () => {
    const again = await run(buf, 'apply');
    expect(again.alreadyImportedRunId).toBe(first.runId);
    expect(again.applied).toBe(false);
    expect(formatWorkbookReport(again)).toContain('already imported');
    expect(await count('client', `name = '${CLIENT}'`)).toBe(1);
    const extra = `Client Fictif Bis ${tag}`;
    const changed = await run(
      file({
        Clients: [
          ['Nom', 'Type', 'ICE'],
          [CLIENT, 'company', CLIENT_ICE],
          [extra, 'person', ''],
        ],
      }),
      'apply',
    );
    expect(changed.applied).toBe(true);
    expect(changed.sheets.find((s) => s.kind === 'clients')?.report.counts).toMatchObject({
      exists: 1,
      created: 1,
    });
    expect(await count('client', `name = '${CLIENT}'`)).toBe(1);
    expect(await count('client', `name = '${extra}'`)).toBe(1);
  });
  it('an unknown step: the money is in centimes', async () => {
    const r = await migrator.query<{ price_ht_per_m3_centimes: string }>(
      `select s.price_ht_per_m3_centimes::text from selling_price s join concrete_type t on t.id = s.concrete_type_id where t.code = $1`,
      [T],
    );
    expect(r.rows[0]?.price_ht_per_m3_centimes).toBe('70050');
    const i = await migrator.query<{ amount_centimes: string }>(
      `select amount_centimes::text from payment_instrument where number = $1`,
      [`FAKE${tag}1`],
    );
    expect(i.rows[0]?.amount_centimes).toBe('1250000');
  });
});

describe('all or nothing', () => {
  it('a problem in the last sheet leaves nothing from the earlier ones', async () => {
    const t2 = `V${tag}`.slice(0, 7);
    const c2 = `Client Atomique ${tag}`;
    const r = await run(
      file({
        Types: [
          ['Code', 'Libellé'],
          [t2, `Béton atomique ${tag}`],
        ],
        Clients: [
          ['Nom', 'Type'],
          [c2, 'person'],
        ],
        Cheques: [
          ['Client', 'Type', 'Numéro', 'Banque', 'Montant', 'Date'],
          ['Personne Inconnue', 'chèque', 'ZZ1', 'B', '10', '01/10/2026'],
        ],
        Facture: [
          ['Année', 'Dernier numéro'],
          [year + 1, 7],
        ],
      }),
      'apply',
    );
    expect(r.applied).toBe(false);
    expect(r.totals.error).toBeGreaterThan(0);
    expect(await count('concrete_type', `code = '${t2}'`)).toBe(0);
    expect(await count('client', `name = '${c2}'`)).toBe(0);
    expect(await count('doc_sequence', `year = ${year + 1}`)).toBe(0);
    expect(await count('audit_event', `action = 'import' and after->>'sha256' = '${r.sha256}'`)).toBe(0);
  });
});

describe('the way back', () => {
  it('archives what the run created, cancels its cheques, lists what stays sealed, and is audited; a second call does nothing', async () => {
    const t3 = `X${tag}`.slice(0, 7);
    const c3 = `Client Retour ${tag}`;
    const buf = file({
      Types: [
        ['Code', 'Libellé'],
        [t3, `Béton retour ${tag}`],
      ],
      Composants: [
        ['Nom', 'Unité'],
        [`Ciment Retour ${tag}`, 'g'],
      ],
      Recettes: [
        ['Type', 'Composant', 'Quantité', 'Unité', 'Date'],
        [t3, `Ciment Retour ${tag}`, '300', 'kg', '01/12/2026'],
      ],
      Clients: [
        ['Nom', 'Type'],
        [c3, 'person'],
      ],
      Fournisseurs: [
        ['Nom', 'Catégorie'],
        [`Fournisseur Retour ${tag}`, 'aggregates'],
      ],
      Prix: [
        ['Type', 'Prix', 'Date'],
        [t3, '650', '01/12/2026'],
      ],
      Cheques: [
        ['Client', 'Type', 'Numéro', 'Banque', 'Montant', 'Date'],
        [c3, 'chèque', `RET${tag}`, 'Banque Fictive', '100', '01/10/2026'],
      ],
      Facture: [
        ['Année', 'Dernier numéro'],
        [year + 2, 9],
      ],
    });
    const done = await run(buf, 'apply');
    expect(done.applied).toBe(true);
    const back = await rollbackImport({
      appPool: app,
      actor: stepped,
      runId: done.runId!,
      environment: PROD,
      today: '2026-11-06',
    });
    expect(back.blocked).toEqual([]);
    expect(back.archived).toMatchObject({ client: 1, supplier: 1, concrete_type: 1, component: 1 });
    expect(back.cancelledInstruments).toBe(1);
    expect(back.staysAsRecorded).toMatchObject({ selling_price: 1, recette: 1 });
    expect(await count('client', `name = '${c3}' and status = 'archived'`)).toBe(1);
    expect(await count('concrete_type', `code = '${t3}' and status = 'archived'`)).toBe(1);
    expect(await count('client', `name = '${c3}'`)).toBe(1); // nothing was deleted
    expect(
      await count('audit_event', `action = 'reverse' and table_name = 'import' and row_id = '${done.runId}'`),
    ).toBe(1);
    const second = await rollbackImport({
      appPool: app,
      actor: stepped,
      runId: done.runId!,
      environment: PROD,
    });
    expect(second.alreadyRolledBack).toBe(true);
    // the same bytes are no longer "already imported": the run was undone
    const redo = await run(buf, 'dry-run');
    expect(redo.alreadyImportedRunId).toBeNull();
  });
  it('refuses on training, without step-up, for an unknown run, and changes nothing', async () => {
    await expect(
      rollbackImport({
        appPool: app,
        actor: stepped,
        runId: randomUUID(),
        environment: { ...PROD, trainingMode: true },
      }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT' });
    await expect(
      rollbackImport({ appPool: app, actor: owner, runId: randomUUID(), environment: PROD }),
    ).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    const none = await rollbackImport({
      appPool: app,
      actor: stepped,
      runId: randomUUID(),
      environment: PROD,
    });
    expect(none.blocked[0]).toMatch(/No import with this run id/);
  });
});
