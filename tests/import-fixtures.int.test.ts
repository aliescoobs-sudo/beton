import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXPECTED_PROBLEMS,
  formatWorkbookReport,
  type ImportEnvironment,
  readWorkbook,
  syntheticProblemWorkbook,
  syntheticValidWorkbook,
} from '../src/modules/importer';
import { importWorkbook, rollbackImport } from './helpers/import-proof';
import { defaultMappings } from '../src/modules/importer';
import { createPlant, listPlants, updatePlant } from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

// T2: the synthetic fixtures through the whole tool with the built-in mappings. Everything in the books is invented.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(async () => {
  // the plants are the shared test database's: leave no active extra plant behind (an order then asks for its plant)
  for (const plant of await listPlants(app, stepped)) {
    if (plants.includes(plant.code)) await updatePlant(app, stepped, plant.id, { status: 'archived' });
  }
  await Promise.all([app.end(), migrator.end()]);
});
const PROD: ImportEnvironment = { trainingMode: false, realData: true, simulationEnabled: false };
const tag = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const letters = (n: number, from = 0) =>
  String.fromCharCode(...[...tag].slice(from, from + n).map((c) => 65 + (c.charCodeAt(0) % 26)));
const prefix = `F${letters(2)}`;
const plants: [string, string] = [`QA${letters(4)}`, `QB${letters(4, 1)}`];
let stepped: SessionUser;
// free truck numbers (T<n>, T<n+1>, P<n>): the shared test database already has trucks, and an existing code with another plate is a conflict now
let truckNo = 500;
const count = async (table: string, where = 'true') =>
  Number(
    (await migrator.query<{ n: string }>(`select count(*)::text as n from ${table} where ${where}`)).rows[0]
      ?.n,
  );
const go = (file: Buffer, mode: 'dry-run' | 'apply') =>
  importWorkbook({
    appPool: app,
    actor: stepped,
    file,
    mappings: defaultMappings(),
    mode,
    environment: PROD,
    requireEveryMappedSheet: false,
    openingDate: '2026-01-01',
  });

beforeAll(async () => {
  stepped = { ...(await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner')), stepUpVerified: true };
  for (const code of plants) await createPlant(app, stepped, { code, name: `Centrale fictive ${code}` });
  for (; truckNo < 990; truckNo += 3)
    if (
      (
        await migrator.query('select 1 from truck where code = any($1)', [
          [`T${truckNo}`, `T${truckNo + 1}`, `P${truckNo}`],
        ])
      ).rowCount === 0
    )
      break;
});

describe('the synthetic books', () => {
  it('say FICTIF everywhere: no real-looking name, ICE or phone', () => {
    for (const buf of [
      syntheticValidWorkbook({ prefix, plants, truckNo }),
      syntheticProblemWorkbook({ prefix, plants, truckNo }),
    ]) {
      const cells = readWorkbook(buf).flatMap((s) => s.rows.flat());
      expect(cells.filter((c) => /^\d{15}$/.test(c)).every((c) => c.startsWith('999'))).toBe(true);
      expect(cells.filter((c) => /^0[5-7]\d{8}$/.test(c)).every((c) => c.startsWith('0600000'))).toBe(true);
      expect(cells.filter((c) => /^(CLIENT|FOURNISSEUR)/.test(c)).every((c) => /FICTIF/.test(c))).toBe(true);
    }
  });
});

describe('the valid book', () => {
  const valid = syntheticValidWorkbook({ prefix, plants, truckNo });
  it('passes the dry run, writes everything on the real run, and does nothing the second time', async () => {
    const dry = await go(valid, 'dry-run');
    expect(formatWorkbookReport(dry)).toContain('errors 0');
    expect(dry.totals).toMatchObject({ error: 0, failed: 0 });
    expect(dry.sheets).toHaveLength(11);
    expect(await count('client', `name like '%FICTIF%${prefix}'`)).toBe(0);

    const done = await go(valid, 'apply');
    expect(done.applied, formatWorkbookReport(done)).toBe(true);
    expect(await count('client', `name like 'CLIENT FICTIF%${prefix}'`)).toBe(3);
    expect(await count('supplier', `name like 'FOURNISSEUR FICTIF%${prefix}'`)).toBe(2);
    // money: centimes
    const price = await migrator.query<{ p: string; plant: string | null }>(
      `select s.price_ht_per_m3_centimes::text as p, pl.code as plant from selling_price s
         join concrete_type t on t.id = s.concrete_type_id left join plant pl on pl.id = s.plant_id
        where t.code = $1 order by pl.code nulls first`,
      [`${prefix}25`],
    );
    expect(price.rows).toEqual([
      { p: '76000', plant: null },
      { p: '77500', plant: plants[0] },
      { p: '77050', plant: plants[1] },
    ]);
    expect(
      await count('recette', `concrete_type_id = (select id from concrete_type where code = '${prefix}25')`),
    ).toBe(2);
    expect(await count('payment_instrument', `number like 'FICTIF-${prefix}-%'`)).toBe(2);

    expect((await go(valid, 'apply')).alreadyImportedRunId).toBe(done.runId);
    expect(await count('client', `name like 'CLIENT FICTIF%${prefix}'`)).toBe(3);

    const back = await rollbackImport({
      appPool: app,
      actor: stepped,
      runId: done.runId!,
      environment: PROD,
    });
    expect(back.blocked).toEqual([]);
    expect(back.archived).toMatchObject({ client: 3, supplier: 2, concrete_type: 3, component: 4 });
    expect(back.cancelledInstruments).toBe(2);
    expect(await count('client', `name like 'CLIENT FICTIF%${prefix}' and status = 'archived'`)).toBe(3);
  });
});

const KIND_OF_SHEET: Record<string, string> = {
  Clients: 'clients',
  Camions: 'trucks',
  Prix: 'selling_prices',
  Soldes: 'opening_balances',
  Cheques: 'cheques_in_transit',
  Facture: 'invoice_sequence',
};

describe('the book with problems', () => {
  it('names each known fault by sheet and row, applies nothing, and shows no cell', async () => {
    // another prefix: the valid book above is in this database already, and a row that exists is not a row that is wrong
    const other = `G${letters(2, 3)}`;
    const buf = syntheticProblemWorkbook({ prefix: other, plants });
    const r = await go(buf, 'apply');
    expect(r.applied).toBe(false);
    const text = formatWorkbookReport(r);
    for (const [sheet, row, phrase] of EXPECTED_PROBLEMS) {
      // sheets are named by position in the report (R14-09): the block of a sheet is found by its kind
      const kind = KIND_OF_SHEET[sheet];
      const block =
        text
          .split('\n')
          .slice(text.split('\n').findIndex((l) => new RegExp(`^\\[Sheet \\d+\\] ${kind}:`).test(l)))
          .join('\n')
          .split('\n[')[0] ?? '';
      expect(block, `${sheet} row ${row}`).toMatch(new RegExp(`row ${row}: [^\\n]*${phrase}`));
    }
    expect(text).not.toContain('FICTIF');
    expect(await count('client', `name like '%FICTIF%${other}'`)).toBe(0);
  });
});
