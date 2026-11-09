import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ImportEnvironment, type SheetMapping, type WorkbookReport } from '../src/modules/importer';
import { importWorkbook, rollbackImport } from './helpers/import-proof';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { createClient } from '../src/modules/master-data';
import { buildWorkbook } from './helpers/xlsx-writer';

// R14-08: imports are serialized, and "already there" means the same payload. Synthetic data only.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));
const PROD: ImportEnvironment = { trainingMode: false, realData: true, simulationEnabled: false };
let stepped: SessionUser;
beforeAll(async () => {
  stepped = {
    ...(await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner')),
    stepUpVerified: true,
  } as SessionUser;
});
const tag = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const map = (sheet: string, kind: SheetMapping['kind']): SheetMapping => ({
  version: 1,
  sheet,
  kind,
  headerRow: 1,
  dateFormat: 'dmy',
  columns: {},
});
const fakeIce = () => String(Math.floor(Math.random() * 9e14) + 1e14);
const run = (
  file: Buffer,
  mode: 'apply' | 'dry-run',
  kind: SheetMapping['kind'],
  sheet: string,
): Promise<WorkbookReport> =>
  importWorkbook({
    appPool: app,
    actor: stepped,
    file,
    mappings: [map(sheet, kind)],
    mode,
    environment: PROD,
    requireEveryMappedSheet: false,
  });
const clientsFile = (name: string, ice: string, phone = '0600000000') =>
  buildWorkbook([
    {
      name: 'Clients',
      rows: [
        ['Nom', 'Type', 'ICE', 'Téléphone'],
        [name, 'company', ice, phone],
      ],
    },
  ]);

describe('imports are serialized (R14-08)', () => {
  it('two simultaneous applies of the SAME file: one applies, the other finds it already imported; one client, not two', async () => {
    const name = `Client Fictif Serie ${tag}`;
    const file = clientsFile(name, fakeIce());
    const [a, b] = await Promise.all([
      run(file, 'apply', 'clients', 'Clients'),
      run(file, 'apply', 'clients', 'Clients'),
    ]);
    expect([a.applied, b.applied].filter(Boolean)).toHaveLength(1);
    const loser = a.applied ? b : a;
    expect(loser.alreadyImportedRunId).toBe((a.applied ? a : b).runId);
    expect(
      (await migrator.query('select 1 from client where lower(name) = lower($1)', [name])).rowCount,
    ).toBe(1);
  });

  it('two simultaneous applies of DIFFERENT files for the same new person: the second is blocked or deduplicated, never a second client', async () => {
    const name = `Client Fictif Double ${tag}`;
    const f1 = clientsFile(name, fakeIce());
    const f2 = clientsFile(name, fakeIce()); // other bytes, same person, another ICE
    const results = await Promise.all([
      run(f1, 'apply', 'clients', 'Clients'),
      run(f2, 'apply', 'clients', 'Clients'),
    ]);
    expect(
      (await migrator.query('select 1 from client where lower(name) = lower($1)', [name])).rowCount,
    ).toBe(1);
    // the second file saw the first one's client AFTER it committed: its ICE differs, so it is a conflict, not "already there"
    const blocked = results.find((r) => !r.applied)!;
    expect(blocked.totals.error).toBe(1);
    expect(blocked.totals.exists).toBe(0);
  });
});

describe('"already there" means the same payload (R14-08)', () => {
  it('an identical row is "already there"; a changed phone, ICE or price at an existing key BLOCKS the file', async () => {
    const name = `Client Fictif Meme ${tag}`;
    const ice = fakeIce();
    expect((await run(clientsFile(name, ice), 'apply', 'clients', 'Clients')).applied).toBe(true);
    const same = await run(clientsFile(name, ice, '0600000000 '), 'dry-run', 'clients', 'Clients'); // other bytes? no: same values
    expect(same.totals.exists).toBe(1);
    const phone = await run(clientsFile(name, ice, '0611111111'), 'dry-run', 'clients', 'Clients');
    expect(phone.totals.error).toBe(1);
    expect(phone.totals.exists).toBe(0);
    expect(phone.sheets[0]?.report.rows[0]?.message).toMatch(/differs in: phone/);
    const otherIce = await run(clientsFile(name, fakeIce()), 'dry-run', 'clients', 'Clients');
    expect(otherIce.totals.error).toBe(1);
    // the message names fields, never a value
    expect(JSON.stringify(phone.sheets[0]?.report.rows)).not.toContain('0611111111');
  });

  it('a concrete type at an existing code with another label is a conflict', async () => {
    const code = `C${tag.slice(0, 5)}`;
    const file = (label: string) =>
      buildWorkbook([
        {
          name: 'Types',
          rows: [
            ['Code', 'Libellé'],
            [code, label],
          ],
        },
      ]);
    const first = await run(file(`Béton fictif ${tag}`), 'apply', 'concrete_types', 'Types');
    expect(first.applied, JSON.stringify([first.fileProblems, first.sheets.map((s) => s.report.rows)])).toBe(
      true,
    );
    // other bytes (two spaces, collapsed by the parser), same payload: the same bytes would be "already imported", a different question
    expect(
      (await run(file(`Béton  fictif ${tag}`), 'dry-run', 'concrete_types', 'Types')).totals.exists,
    ).toBe(1);
    const changed = await run(file(`Autre libellé ${tag}`), 'dry-run', 'concrete_types', 'Types');
    expect(changed.totals.error).toBe(1);
    expect(changed.sheets[0]?.report.rows[0]?.message).toMatch(/differs in: label/);
  });
});

describe('opening balances (R14-08)', () => {
  it('two rows for the same party in one workbook block the file instead of the second being "already there"', async () => {
    const name = `Client Fictif Solde ${tag}`;
    expect((await run(clientsFile(name, fakeIce()), 'apply', 'clients', 'Clients')).applied).toBe(true);
    const file = buildWorkbook([
      {
        name: 'Soldes',
        rows: [
          ['Tiers', 'Code', 'Montant'],
          ['client', name, '100,00'],
          ['client', name, '200,00'],
        ],
      },
    ]);
    // a dry run: nothing is written (the opening date of the books is a singleton of the shared test database)
    const r = await importWorkbook({
      appPool: app,
      actor: stepped,
      file,
      mappings: [map('Soldes', 'opening_balances')],
      mode: 'dry-run',
      environment: PROD,
      requireEveryMappedSheet: false,
      openingDate: '2026-01-01',
    });
    expect(r.totals.error).toBe(1);
    expect(r.totals.exists).toBe(0);
    expect(r.sheets[0]?.report.rows.some((x) => /two opening-balance rows/.test(x.message ?? ''))).toBe(true);
  });
});

describe('R15B-09: a name shared by several records identifies none of them', () => {
  const twin = `Client Fictif Jumeau ${tag}`;
  const codes: string[] = [];
  beforeAll(async () => {
    for (const _ of [1, 2]) {
      const c = await createClient(app, stepped, { name: twin, kind: 'person' });
      if (!c.ok) throw new Error(c.error);
      codes.push(c.value.client.code);
    }
  });
  const dry = (file: Buffer, kind: SheetMapping['kind'], sheet: string) =>
    importWorkbook({
      appPool: app,
      actor: stepped,
      file,
      mappings: [map(sheet, kind)],
      mode: 'dry-run',
      environment: PROD,
      requireEveryMappedSheet: false,
      openingDate: '2026-01-01',
    });
  it('an opening balance named by the shared name is refused; named by a unique code it is accepted', async () => {
    const byName = await dry(
      buildWorkbook([
        {
          name: 'Soldes',
          rows: [
            ['Tiers', 'Code', 'Montant'],
            ['client', twin, '10,00'],
          ],
        },
      ]),
      'opening_balances',
      'Soldes',
    );
    expect(byName.totals.error).toBe(1);
    expect(byName.sheets[0]?.report.rows[0]?.message).toMatch(/several records/);
    const byCode = await dry(
      buildWorkbook([
        {
          name: 'Soldes',
          rows: [
            ['Tiers', 'Code', 'Montant'],
            ['client', codes[0]!, '10,00'],
          ],
        },
      ]),
      'opening_balances',
      'Soldes',
    );
    expect(byCode.sheets[0]?.report.rows[0]?.message ?? '').not.toMatch(/several records/);
  });
  it('a cheque for the shared name is refused', async () => {
    const r = await dry(
      buildWorkbook([
        {
          name: 'Cheques',
          rows: [
            ['Client', 'Type', 'Numéro', 'Banque', 'Montant', 'Date'],
            [twin, 'cheque', `N${tag}`, 'Banque Fictive', '100,00', '01/01/2026'],
          ],
        },
      ]),
      'cheques_in_transit',
      'Cheques',
    );
    expect(r.sheets[0]?.report.rows[0]?.message).toMatch(/several records/);
  });
  it('a clients row with the shared name is refused instead of being compared with an arbitrary one of them', async () => {
    const r = await dry(clientsFile(twin, fakeIce()), 'clients', 'Clients');
    expect(r.totals.error).toBe(1);
    expect(r.sheets[0]?.report.rows[0]?.message).toMatch(/several records/);
  });
});

describe('R15B-10: "already imported" means the same file AND the same operation', () => {
  const two = (tagName: string) =>
    buildWorkbook([
      {
        name: 'Clients',
        rows: [
          ['Nom', 'Type', 'ICE'],
          [`Client Fictif Op ${tagName}`, 'person', ''],
        ],
      },
      {
        name: 'Soldes',
        rows: [
          ['Tiers', 'Code', 'Montant'],
          ['client', `Client Fictif Op ${tagName}`, '10,00'],
        ],
      },
    ]);
  const go = (file: Buffer, sheets: [string, SheetMapping['kind']][], mode: 'apply' | 'dry-run') =>
    importWorkbook({
      appPool: app,
      actor: stepped,
      file,
      mappings: sheets.map(([s, k]) => map(s, k)),
      mode,
      environment: PROD,
      requireEveryMappedSheet: false,
      openingDate: '2026-01-01',
    });
  it('the same bytes with a mapping that adds a sheet are NOT reported as already imported', async () => {
    const file = two(`${tag}x`);
    const first = await go(file, [['Clients', 'clients']], 'apply');
    expect(first.applied).toBe(true);
    // identical operation: still "already imported"
    expect((await go(file, [['Clients', 'clients']], 'dry-run')).alreadyImportedRunId).toBe(first.runId);
    // another mapping of the same bytes: refused with a reason, never "NOTHING DONE: already imported"
    const other = await go(
      file,
      [
        ['Clients', 'clients'],
        ['Soldes', 'opening_balances'],
      ],
      'dry-run',
    );
    expect(other.alreadyImportedRunId).toBeNull();
    expect(other.fileProblems.join(' ')).toMatch(/another mapping or opening date/);
  });
  it('the same bytes with another opening date are refused too', async () => {
    const file = two(`${tag}y`);
    const first = await go(file, [['Clients', 'clients']], 'apply');
    expect(first.applied).toBe(true);
    const other = await importWorkbook({
      appPool: app,
      actor: stepped,
      file,
      mappings: [map('Clients', 'clients')],
      mode: 'dry-run',
      environment: PROD,
      requireEveryMappedSheet: false,
      openingDate: '2026-02-02',
    });
    expect(other.alreadyImportedRunId).toBeNull();
    expect(other.fileProblems.join(' ')).toMatch(/another mapping or opening date/);
  });
});
