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
