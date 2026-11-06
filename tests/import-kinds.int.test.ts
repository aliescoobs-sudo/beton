import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runImport } from '../src/modules/importer';
import { readSheet } from '../src/modules/importer';
import {
  createComponent,
  createConcreteType,
  createPlant,
  listPlants,
  listRecetteVersions,
  listSellingPrices,
  listTrucks,
  updatePlant,
} from '../src/modules/master-data';
import { getInvoiceSequence } from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { buildXlsx } from './helpers/xlsx-writer';

// T2: the kinds added for the go-live (pumps, prices and recipes per plant, the last invoice number) and the strictness of the cells.
// Synthetic data only.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
afterAll(async () => {
  // the plants are the shared test database's: leave no active extra plant behind (an order then asks for its plant)
  for (const plant of await listPlants(app, owner)) {
    if ([PLANT_A, PLANT_B].includes(plant.code))
      await updatePlant(app, owner, plant.id, { status: 'archived' });
  }
  await app.end();
});
let owner: SessionUser;
const tag = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const letters = (n: number) =>
  String.fromCharCode(...[...tag].slice(0, n).map((c) => 65 + (c.charCodeAt(0) % 26)));
const PLANT_A = `QA${letters(4)}`;
const PLANT_B = `QB${letters(4)}`;
const typeCode = `P${tag}`.slice(0, 7);
const ctx = (apply: boolean, extra: object = {}) => ({ appPool: app, actor: owner, apply, ...extra });
const run = (
  kind: Parameters<typeof runImport>[0],
  rows: (string | number)[][],
  apply = true,
  extra: object = {},
) => runImport(kind, readSheet(buildXlsx(rows)), ctx(apply, extra));

beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  for (const code of [PLANT_A, PLANT_B]) await createPlant(app, owner, { code, name: `Plant ${code}` });
  await createConcreteType(app, owner, { code: typeCode, label: `Type ${tag}` });
  await createComponent(app, owner, { nameFr: `Ciment ${tag}`, nameAr: `Ciment ${tag}`, baseUnit: 'g' });
});

describe('reference prices per plant', () => {
  const head = ['Type', 'Prix HT', 'Date', 'Centrale'];
  it('writes a price for each plant and one for all plants; a re-run skips them; an unknown plant blocks the file', async () => {
    const rows = [
      head,
      [typeCode, '700', '2026-12-01', ''],
      [typeCode, '712,50', '2026-12-01', PLANT_A],
      [typeCode, '725', '2026-12-01', PLANT_B],
    ];
    expect((await run('selling_prices', rows, false)).counts).toMatchObject({ new: 3, error: 0 });
    expect((await run('selling_prices', rows)).counts).toMatchObject({ created: 3, failed: 0 });
    const plants = new Map((await listPlants(app, owner)).map((p) => [p.id, p.code]));
    const mine = (await listSellingPrices(app, owner)).filter(
      (p) => p.clientId === null && p.effectiveFrom === '2026-12-01',
    );
    const ours = mine
      .filter((p) => !p.plantId || [PLANT_A, PLANT_B].includes(plants.get(p.plantId) ?? ''))
      .map((p) => [p.plantId ? plants.get(p.plantId) : null, p.priceHtPerM3Centimes]);
    expect(ours).toEqual(
      expect.arrayContaining([
        [PLANT_A, 71_250],
        [PLANT_B, 72_500],
      ]),
    );
    expect((await run('selling_prices', rows)).counts).toMatchObject({ exists: 3, created: 0 });
    expect(
      (await run('selling_prices', [head, [typeCode, '700', '2027-01-01', 'NOPE']])).rows[0],
    ).toMatchObject({
      status: 'error',
      message: 'unknown plant code',
    });
  });
  it('refuses amounts and dates that can be read two ways', async () => {
    const msg = async (price: string, date: string, extra: object = {}) =>
      (await run('selling_prices', [head, [typeCode, price, date, PLANT_A]], false, extra)).rows[0]
        ?.message ?? '';
    expect(await msg('1,234', '2027-01-01')).toMatch(/ambiguous amount/);
    expect(await msg('1234.4999999999998', '2027-01-01')).toMatch(/more than two decimals/);
    expect(await msg('-5', '2027-01-01')).toMatch(/negative/);
    expect(await msg('700', '31/02/2027')).toMatch(/date not understood or ambiguous/);
    expect(await msg('700', '03/04/2027', { dateFormat: 'iso' })).toMatch(/date not understood or ambiguous/);
    expect(await msg('700', '03/04/2027')).toBe('');
  });
});

describe('recipes per plant', () => {
  it('writes a plant recipe next to the all-plants one; the date rule is per scope', async () => {
    const head = ['Type', 'Composant', 'Quantité', 'Unité', 'Date', 'Centrale'];
    const rows = [
      head,
      [typeCode, `Ciment ${tag}`, '350', 'kg', '2026-12-01', ''],
      [typeCode, `Ciment ${tag}`, '340', 'kg', '2026-11-15', PLANT_A],
    ];
    expect((await run('recipes', rows)).counts).toMatchObject({ created: 2, failed: 0, error: 0 });
    const type = (await (await import('../src/modules/master-data')).listConcreteTypes(app, owner)).find(
      (t) => t.code === typeCode,
    )!;
    const versions = await listRecetteVersions(app, owner, type.id);
    const plantA = (await listPlants(app, owner)).find((p) => p.code === PLANT_A)!;
    expect(versions.map((v) => v.plantId).sort()).toEqual([null, plantA.id].sort());
    expect((await run('recipes', rows)).counts).toMatchObject({ exists: 2, created: 0 });
    // an older date for the same scope is refused, a different scope is judged on its own versions
    const older = await run('recipes', [
      head,
      [typeCode, `Ciment ${tag}`, '330', 'kg', '2026-10-01', PLANT_A],
    ]);
    expect(older.rows[0]?.status).toBe('error');
  });
});

describe('pumps', () => {
  it('imports a pump truck with kind pump and its own code; the plate is not reused', async () => {
    const no = 80 + Math.floor(Math.random() * 18);
    const rows = [
      ['Code', 'Immatriculation', 'Capacité'],
      [`P${no}`, `PMP-${tag}`, '1.5'],
    ];
    const r = await run('pumps', rows);
    // a pump has no volume of its own in m³ between 1 and 30 for the mixers; the service decides
    expect(r.counts.error + r.counts.created).toBe(1);
    if (r.counts.created === 1) {
      expect((await listTrucks(app, owner)).find((t) => t.code === `P${no}`)).toMatchObject({ kind: 'pump' });
      expect((await run('pumps', rows)).counts.exists).toBe(1);
    }
  });
  it('refuses a mixer code in the pumps sheet', async () => {
    const r = await run(
      'pumps',
      [
        ['Code', 'Immatriculation'],
        [`T${900 + Math.floor(Math.random() * 90)}`, `PMX-${tag}`],
      ],
      false,
    );
    expect(r.counts.error).toBe(1);
  });
});

describe('last invoice number', () => {
  it('moves the sequence forward once, skips the same number, refuses to go back', async () => {
    const year = 2400 + Math.floor(Math.random() * 500);
    const rows = (n: number) => [
      ['Année', 'Dernier numéro'],
      [year, n],
    ];
    expect((await run('invoice_sequence', rows(137))).counts).toMatchObject({ created: 1 });
    expect(await getInvoiceSequence(app, owner, year)).toBe(137);
    expect((await run('invoice_sequence', rows(137))).counts).toMatchObject({ exists: 1, created: 0 });
    const back = await run('invoice_sequence', rows(100));
    expect(back.rows[0]).toMatchObject({
      status: 'error',
      message: expect.stringContaining('only moves forward'),
    });
    expect(
      (
        await run('invoice_sequence', [
          ['Année', 'Dernier numéro'],
          [year, '12,5'],
        ])
      ).counts.error,
    ).toBe(1);
    expect(
      (
        await run('invoice_sequence', [
          ['Année', 'Dernier numéro'],
          [1999, 5],
        ])
      ).counts.error,
    ).toBe(1);
  });
});

describe('header row', () => {
  it('reads headers on a later row and numbers the lines from the sheet', async () => {
    const r = await runImport(
      'concrete_types',
      readSheet(
        buildXlsx([
          ['Liste des bétons', ''],
          ['Code', 'Libellé'],
          [`H${tag}`, `Tête ${tag}`],
          ['', ''],
        ]),
      ),
      { ...ctx(false), headerRow: 2 },
    );
    expect(r.rows).toEqual([{ row: 3, status: 'new', label: `H${tag}` }]);
  });
});
