import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatWorkbookReport,
  type ImportEnvironment,
  importWorkbook,
  type SheetMapping,
} from '../src/modules/importer';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { buildWorkbook } from './helpers/xlsx-writer';

// R14-04 at the level of the whole workbook: the refusals reach the report, nothing is written. Dry runs only (a rolled-back transaction).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());
const PROD: ImportEnvironment = { trainingMode: false, realData: true, simulationEnabled: false };
let owner: SessionUser;
beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
});
const mapping = (extra: Partial<SheetMapping> = {}): SheetMapping => ({
  version: 1,
  sheet: 'Clients',
  kind: 'clients',
  headerRow: 1,
  dateFormat: 'dmy',
  columns: {},
  ...extra,
});
const dry = (file: Buffer, m = mapping()) =>
  importWorkbook({
    appPool: app,
    actor: owner,
    file,
    mappings: [m],
    mode: 'dry-run',
    environment: PROD,
    requireEveryMappedSheet: false,
  });
const head = ['Nom', 'Type', 'ICE', 'Téléphone'];
const row = ['Client Fictif Strict', 'company', '123456789012345', '0600000000'];

describe('strict reading reaches the report (R14-04)', () => {
  it('a clean sheet is accepted (control)', async () => {
    const r = await dry(buildWorkbook([{ name: 'Clients', rows: [head, row] }]));
    expect(r.fileProblems).toEqual([]);
    expect(r.totals.error).toBe(0);
  });

  it('a 1904 workbook is refused as a file problem and nothing is read', async () => {
    const r = await dry(buildWorkbook([{ name: 'Clients', rows: [head, row] }], false, { date1904: true }));
    expect(r.fileProblems.join(' ')).toMatch(/1904 date system/);
    expect(r.sheets).toEqual([]);
  });

  it('duplicate accepted headers block the sheet', async () => {
    const r = await dry(
      buildWorkbook([
        {
          name: 'Clients',
          rows: [
            ['Nom', 'Client', 'Type', 'ICE'],
            ['A', 'B', 'company', '123456789012345'],
          ],
        },
      ]),
    );
    expect(r.sheets[0]?.report.missingColumns.join(' ')).toMatch(/two columns have this header/);
  });

  it('a formula cell refuses the sheet unless the mapping allows cached values, and then the report flags it', async () => {
    const file = buildWorkbook([
      {
        name: 'Clients',
        rows: [
          head,
          [
            { f: '"Client "&"Fictif Formule"', v: 'Client Fictif Formule' },
            'company',
            '123456789012345',
            '0600000000',
          ],
        ],
      },
    ]);
    const refused = await dry(file);
    expect(refused.fileProblems.join(' ')).toMatch(/1 formula cell/);
    expect(formatWorkbookReport(refused)).toContain('formula cell');
    const allowed = await dry(file, mapping({ allowCachedFormulaValues: true }));
    expect(allowed.fileProblems).toEqual([]);
    expect(allowed.sheets[0]?.formulaCellsRead).toBe(1);
    expect(formatWorkbookReport(allowed)).toContain('CACHED FORMULA VALUES USED: 1');
  });

  it('a CSV with an unclosed quote is a file problem', async () => {
    const r = await dry(Buffer.from('Nom;Type\n"Client;company\n'), mapping({ sheet: '*' }));
    expect(r.fileProblems.join(' ')).toMatch(/never closed/);
  });
});

describe('a report never carries a cell or a sheet name (R14-09)', () => {
  it('a name in the unit column and a name for the sheet appear nowhere in the text report', async () => {
    const secretCell = 'Ali Benjelloun Secret';
    const secretSheet = 'Feuille Confidentielle';
    const file = buildWorkbook([
      {
        name: 'Types',
        rows: [
          ['Code', 'Libellé'],
          ['QZR9', 'Béton fictif'],
        ],
      },
      {
        name: 'Composants',
        rows: [
          ['Nom', 'Unité'],
          ['Ciment Fictif Rapport', 'g'],
        ],
      },
      // the recipe's unit cell holds a person's name; the unit was interpolated into the message before R14-09
      {
        name: 'Recettes',
        rows: [
          ['Type', 'Composant', 'Quantité', 'Unité', 'Date'],
          ['QZR9', 'Ciment Fictif Rapport', '350', secretCell, '01/12/2026'],
        ],
      },
      { name: secretSheet, rows: [['x'], ['y']] },
    ]);
    const maps: SheetMapping[] = ['Types:concrete_types', 'Composants:components', 'Recettes:recipes'].map(
      (x) => ({
        version: 1,
        sheet: x.split(':')[0]!,
        kind: x.split(':')[1] as SheetMapping['kind'],
        headerRow: 1,
        dateFormat: 'dmy',
        columns: {},
      }),
    );
    const r = await importWorkbook({
      appPool: app,
      actor: owner,
      file,
      mappings: maps,
      mode: 'dry-run',
      environment: PROD,
      requireEveryMappedSheet: false,
    });
    const text = formatWorkbookReport(r);
    expect(r.totals.error + r.totals.failed).toBeGreaterThan(0); // the bad unit is reported...
    expect(text).not.toContain(secretCell); // ...without the cell
    expect(text).not.toContain('Ali');
    expect(text).not.toContain(secretSheet);
    expect(r.unmappedSheets).toEqual(['Sheet 4']);
    expect(text).toMatch(/Sheet 4/);
    for (const s of r.sheets) expect(s.sheet).toMatch(/^Sheet \d+$/);
  });
});
