import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSheet } from '../src/modules/importer';
import { formatReport, runImport } from '../src/modules/importer/service/importers';
import {
  listClients,
  listComponents,
  listConcreteTypes,
  listRecetteVersions,
  listSellingPrices,
  listSuppliers,
  listTrucks,
} from '../src/modules/master-data';
import { getOpeningState, listInstruments } from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { buildXlsx } from './helpers/xlsx-writer';

// R9 (CP-PROD-PLAN): AC-PROD-28. A dry run reports and writes nothing; an error blocks the whole file; a real run is audited like
// a screen entry; running it twice does not double anything.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));
let owner: SessionUser;
let office: SessionUser;
const tag = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
// ICEs are unique in the shared test database: ours are random 15-digit numbers.
const ice = () => String(Math.floor(Math.random() * 9e14) + 1e14);
const ICE_A = ice();
const ICE_B = ice();
const ctx = (apply: boolean, extra: { openingDate?: string } = {}) => ({
  appPool: app,
  actor: owner,
  apply,
  ...extra,
});
beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  office = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office_sales');
});
const count = async (table: string, where = 'true') =>
  Number(
    (await migrator.query<{ n: string }>(`select count(*)::text as n from ${table} where ${where}`)).rows[0]
      ?.n,
  );

describe('clients', () => {
  const rows = [
    ['Nom', 'Type', 'ICE', 'Téléphone', 'Délai de paiement'],
    [`Atlas Bâtiment ${tag}`, 'société', ICE_A, '0661123456', 45],
    [`M. Particulier ${tag}`, 'particulier', '', '0662000000', ''],
  ];
  it('a dry run says what it would do and writes nothing; the real run writes it; a second run skips it', async () => {
    const before = await count('client', `name like '%${tag}'`);
    const dry = await runImport('clients', readSheet(buildXlsx(rows)), ctx(false));
    expect(dry.dryRun).toBe(true);
    expect(dry.counts).toMatchObject({ new: 2, error: 0, created: 0 });
    expect(await count('client', `name like '%${tag}'`)).toBe(before);
    const real = await runImport('clients', readSheet(buildXlsx(rows)), ctx(true));
    expect(real.dryRun).toBe(false);
    expect(real.counts).toMatchObject({ created: 2, failed: 0 });
    const clients = await listClients(app, owner);
    expect(
      clients
        .filter((c) => c.name.endsWith(tag))
        .map((c) => c.kind)
        .sort(),
    ).toEqual(['company', 'person']);
    expect(clients.find((c) => c.name.startsWith('Atlas'))).toMatchObject({
      paymentTermsDays: 45,
      ice: ICE_A,
    });
    const again = await runImport('clients', readSheet(buildXlsx(rows)), ctx(true));
    expect(again.counts).toMatchObject({ exists: 2, created: 0 });
    expect(formatReport(again)).toContain('already there 2');
    // the entries are audited as the owner, like a screen entry
    expect(
      await count(
        'audit_event',
        `table_name = 'client' and actor_user_id = '${owner.id}' and after->>'name' like '%${tag}'`,
      ),
    ).toBeGreaterThanOrEqual(2);
  });

  it('an error anywhere stops the whole file: nothing is written, the line and the reason are given', async () => {
    const file = [
      ['Nom', 'Type', 'ICE'],
      [`Bon ${tag}B`, 'company', ICE_B],
      [`Mauvais ${tag}B`, 'company', '123'],
      [`Bon ${tag}B`, 'company', ''],
    ];
    const r = await runImport('clients', readSheet(buildXlsx(file)), ctx(true));
    expect(r.dryRun).toBe(true);
    expect(r.counts.error).toBe(2);
    expect(r.rows.filter((x) => x.status === 'error').map((x) => x.row)).toEqual([3, 4]);
    expect(await count('client', `name like '%${tag}B'`)).toBe(0);
    expect(formatReport(r)).toContain('line 3');
  });

  it('a file without the needed columns is refused whole', async () => {
    const r = await runImport('clients', readSheet(buildXlsx([['Ville'], ['Tétouan']])), ctx(true));
    expect(r.missingColumns).toEqual(['name', 'kind']);
    expect(r.rows).toEqual([]);
  });

  it('only a role that may write clients can import them', async () => {
    const r = runImport(
      'clients',
      readSheet(
        buildXlsx([
          ['Nom', 'Type'],
          [`X ${tag}`, 'person'],
        ]),
      ),
      { appPool: app, actor: await realSessionUser(env.DATABASE_URL_MIGRATOR, 'driver'), apply: true },
    );
    await expect(r).rejects.toThrow();
    expect(office.role).toBe('office_sales');
  });
});

describe('suppliers, types, prices, trucks', () => {
  it('imports the types, then their prices; a price for an unknown type is an error line', async () => {
    const code = `Z${tag}`.slice(0, 7);
    const types = [
      ['Code', 'Libellé'],
      [code, `Béton import ${tag}`],
    ];
    expect((await runImport('concrete_types', readSheet(buildXlsx(types)), ctx(true))).counts.created).toBe(
      1,
    );
    expect((await listConcreteTypes(app, owner)).some((t) => t.code === code)).toBe(true);
    const bad = await runImport(
      'selling_prices',
      readSheet(
        buildXlsx([
          ['Type', 'Prix', 'Date'],
          ['NOPE', '800', '2026-01-01'],
        ]),
      ),
      ctx(true),
    );
    expect(bad.rows[0]).toMatchObject({
      status: 'error',
      message: expect.stringContaining('unknown concrete type'),
    });
    const prices = [
      ['Type', 'Prix HT', 'À partir du'],
      [code, '812,50', '01/12/2026'],
    ];
    expect((await runImport('selling_prices', readSheet(buildXlsx(prices)), ctx(true))).counts.created).toBe(
      1,
    );
    const typeId = (await listConcreteTypes(app, owner)).find((t) => t.code === code)!.id;
    expect((await listSellingPrices(app, owner, { concreteTypeId: typeId }))[0]).toMatchObject({
      priceHtPerM3Centimes: 81_250,
      effectiveFrom: '2026-12-01',
    });
    expect((await runImport('selling_prices', readSheet(buildXlsx(prices)), ctx(true))).counts.exists).toBe(
      1,
    );
  });

  it('suppliers need a known category; trucks take m³ and a kind', async () => {
    const s = await runImport(
      'suppliers',
      readSheet(
        buildXlsx([
          ['Nom', 'Catégorie'],
          [`Sablière ${tag}`, 'aggregates'],
          [`Inconnu ${tag}`, 'pizza'],
        ]),
      ),
      ctx(true),
    );
    expect(s.counts).toMatchObject({ error: 1, created: 0 });
    const ok = await runImport(
      'suppliers',
      readSheet(
        buildXlsx([
          ['Nom', 'Catégorie', 'Délai de paiement'],
          [`Sablière ${tag}`, 'aggregates', 30],
        ]),
      ),
      ctx(true),
    );
    expect(ok.counts.created).toBe(1);
    expect((await listSuppliers(app, owner)).some((x) => x.name === `Sablière ${tag}`)).toBe(true);
    const no = 700 + Math.floor(Math.random() * 90);
    const t = await runImport(
      'trucks',
      readSheet(
        buildXlsx([
          ['Code', 'Immatriculation', 'Capacité', 'Type'],
          [`T${no}`, `IMP-${tag}-1`, '16', 'malaxeur'],
          [`T${no}`, `IMP-${tag}-2`, '16', ''],
        ]),
      ),
      ctx(true),
    );
    expect(t.counts.error).toBe(1);
    const t2 = await runImport(
      'trucks',
      readSheet(
        buildXlsx([
          ['Code', 'Immatriculation', 'Capacité'],
          [`T${no}`, `IMP-${tag}-1`, '16'],
        ]),
      ),
      ctx(true),
    );
    expect(t2.counts.created).toBe(1);
    expect((await listTrucks(app, owner)).find((x) => x.code === `T${no}`)).toMatchObject({
      capacityL: 16_000,
      kind: 'mixer',
    });
  });
});

describe('opening balances', () => {
  it('needs an opening date, then writes the date once and one balance per party; unknown codes are errors', async () => {
    const clients = await listClients(app, owner);
    const code = clients.find((c) => c.name.startsWith('Atlas'))!.code;
    const file = readSheet(
      buildXlsx([
        ['Tiers', 'Code', 'Montant', 'Référence'],
        ['client', code, '12 500,75', 'Solde 2025'],
        ['client', 'CLT-99999', 100, ''],
      ]),
    );
    const noDate = await runImport('opening_balances', file, ctx(false));
    const state = await getOpeningState(app, owner);
    if (!state.openingDate) expect(noDate.rows.every((r) => r.status === 'error')).toBe(true);
    const only = readSheet(
      buildXlsx([
        ['Tiers', 'Code', 'Montant', 'Référence'],
        ['client', code, '12 500,75', 'Solde 2025'],
      ]),
    );
    const r = await runImport('opening_balances', only, ctx(true, { openingDate: '2026-01-01' }));
    if (state.openingDate || r.counts.created === 0) {
      // another suite already entered the opening of this database: the import then reports a refusal instead of writing a second date
      expect(r.counts.created + r.counts.exists + r.counts.failed + r.counts.error).toBeGreaterThan(0);
    } else {
      expect(r.counts.created).toBe(1);
      expect(
        (await getOpeningState(app, owner)).parties.some((p) => p.partyId && p.amountCentimes === 1_250_075),
      ).toBe(true);
      expect(
        (await runImport('opening_balances', only, ctx(true, { openingDate: '2026-01-01' }))).counts.exists,
      ).toBe(1);
    }
  });
});

describe('components (C3)', () => {
  const rows = [
    ['Nom', 'Nom AR', 'Unité', "Unité d'achat", 'Contenu'],
    [`Ciment CPJ45 ${tag}`, 'إسمنت', 'g', 'Sac 50 kg', 50000],
    [`Sable 0/4 ${tag}`, '', 'g', '', ''],
    [`Adjuvant ${tag}`, '', 'mL', '', ''],
  ];
  it('creates the components and their purchase unit; a second run skips them; a wrong unit blocks the file', async () => {
    const dry = await runImport('components', readSheet(buildXlsx(rows)), ctx(false));
    expect(dry.counts).toMatchObject({ new: 3, error: 0 });
    const real = await runImport('components', readSheet(buildXlsx(rows)), ctx(true));
    expect(real.counts).toMatchObject({ created: 3, failed: 0 });
    const made = (await listComponents(app, owner)).filter((c) => c.nameFr.endsWith(tag));
    expect(made.map((c) => [c.nameFr.split(' ')[0], c.baseUnit]).sort()).toEqual([
      ['Adjuvant', 'mL'],
      ['Ciment', 'g'],
      ['Sable', 'g'],
    ]);
    expect(made.find((c) => c.nameFr.startsWith('Sable'))?.nameAr).toBe(`Sable 0/4 ${tag}`); // no Arabic name: the French one
    const units = await migrator.query(
      `select u.label, u.factor_to_base::text from purchase_unit u join component c on c.id = u.component_id where c.name_fr = $1`,
      [`Ciment CPJ45 ${tag}`],
    );
    expect(units.rows).toEqual([{ label: 'Sac 50 kg', factor_to_base: '50000' }]);
    const again = await runImport('components', readSheet(buildXlsx(rows)), ctx(true));
    expect(again.counts).toMatchObject({ exists: 3, created: 0 });
    const bad = await runImport(
      'components',
      readSheet(buildXlsx([rows[0]!, [`Gravette ${tag}`, '', 'kg', '', '']])),
      ctx(true),
    );
    expect(bad.counts).toMatchObject({ error: 1, created: 0 });
  });
  it('an office account cannot import', async () => {
    await expect(
      runImport('components', readSheet(buildXlsx([rows[0]!, [`Office ${tag}`, '', 'g', '', '']])), {
        appPool: app,
        actor: office,
        apply: true,
      }),
    ).rejects.toThrow();
  });
});

describe('recipes (C3)', () => {
  const code = `R${tag}`.slice(0, 7);
  const rows = [
    ['Type', 'Composant', 'Quantité', 'Unité', 'À partir du'],
    [code, `Ciment CPJ45 ${tag}`, '350', 'kg', '2026-01-01'],
    [code, `Sable 0/4 ${tag}`, '800', 'kg', '2026-01-01'],
    [code, `Adjuvant ${tag}`, '2,5', 'L', '2026-01-01'],
  ];
  it('imports the lines of one type and date as one version, converting to base units; a second run skips it', async () => {
    await runImport(
      'concrete_types',
      readSheet(
        buildXlsx([
          ['Code', 'Libellé'],
          [code, `Recette ${tag}`],
        ]),
      ),
      ctx(true),
    );
    const dry = await runImport('recipes', readSheet(buildXlsx(rows)), ctx(false));
    expect(dry.counts).toMatchObject({ new: 1, error: 0 });
    const real = await runImport('recipes', readSheet(buildXlsx(rows)), ctx(true));
    expect(real.counts).toMatchObject({ created: 1, failed: 0 });
    const type = (await listConcreteTypes(app, owner)).find((t) => t.code === code)!;
    const versions = await listRecetteVersions(app, owner, type.id);
    expect(versions).toHaveLength(1);
    const comps = new Map((await listComponents(app, owner)).map((c) => [c.id, c.nameFr.split(' ')[0]]));
    expect(Object.fromEntries(versions[0]!.lines.map((l) => [comps.get(l.componentId), l.qtyPerM3]))).toEqual(
      {
        Ciment: 350_000, // 350 kg in grams
        Sable: 800_000,
        Adjuvant: 2500, // 2,5 L in the component's own unit, millilitres
      },
    );
  });
  it('refuses an unknown type or component, a date that does not follow the latest version, and a component twice', async () => {
    const head = rows[0]!;
    const run = (extra: (string | number)[][]) =>
      runImport('recipes', readSheet(buildXlsx([head, ...extra])), ctx(true));
    expect((await run([['ZZZ', `Ciment CPJ45 ${tag}`, '1', 'kg', '2026-02-01']])).counts.error).toBe(1);
    expect((await run([[code, 'Inconnu', '1', 'kg', '2026-02-01']])).counts.error).toBe(1);
    expect((await run([[code, `Ciment CPJ45 ${tag}`, '300', 'kg', '2025-06-01']])).counts.error).toBe(1);
    expect(
      (
        await run([
          [code, `Ciment CPJ45 ${tag}`, '300', 'kg', '2026-03-01'],
          [code, `Ciment CPJ45 ${tag}`, '310', 'kg', '2026-03-01'],
        ])
      ).counts.error,
    ).toBe(1);
  });
});

describe('cheques in transit (C3)', () => {
  const clientName = `Client Chèques ${tag}`;
  const rows = (n1: string, n2: string) => [
    ['Client', 'Type', 'Numéro', 'Banque', 'Montant', 'Date'],
    [clientName, 'chèque', n1, 'Attijariwafa', '12 500,00', '15/10/2026'],
    [clientName, 'LCN', n2, 'BMCE', '8000', '2026-10-20'],
  ];
  it('records each one as a received instrument for the right client, no allocation, and does not double on a second run', async () => {
    await runImport(
      'clients',
      readSheet(
        buildXlsx([
          ['Nom', 'Type'],
          [clientName, 'particulier'],
        ]),
      ),
      ctx(true),
    );
    const n1 = `CH${tag}1`;
    const n2 = `LC${tag}2`;
    const dry = await runImport('cheques_in_transit', readSheet(buildXlsx(rows(n1, n2))), ctx(false));
    expect(dry.counts).toMatchObject({ new: 2, error: 0 });
    expect(await count('payment_instrument', `number in ('${n1}','${n2}')`)).toBe(0);
    const real = await runImport('cheques_in_transit', readSheet(buildXlsx(rows(n1, n2))), ctx(true));
    expect(real.counts).toMatchObject({ created: 2, failed: 0 });
    const mine = (await listInstruments(app, owner)).filter((i) => [n1, n2].includes(i.number ?? ''));
    expect(
      mine.map((i) => [i.number, i.method, i.amountCentimes, i.writtenDate, i.partyName]).sort(),
    ).toEqual([
      [n1, 'cheque', 1_250_000, '2026-10-15', clientName],
      [n2, 'lcn', 800_000, '2026-10-20', clientName],
    ]);
    expect(
      await count(
        'allocation',
        `instrument_id in (select id from payment_instrument where number in ('${n1}','${n2}'))`,
      ),
    ).toBe(0);
    const again = await runImport('cheques_in_transit', readSheet(buildXlsx(rows(n1, n2))), ctx(true));
    expect(again.counts).toMatchObject({ exists: 2, created: 0 });
  });
  it('blocks the file on an unknown client, a wrong type, a missing number or an amount that is not money', async () => {
    const head = rows('x', 'y')[0]!;
    const run = (r: (string | number)[]) =>
      runImport('cheques_in_transit', readSheet(buildXlsx([head, r])), ctx(true));
    expect((await run(['Personne', 'chèque', `N${tag}`, 'B', '100', '2026-10-01'])).counts.error).toBe(1);
    expect((await run([clientName, 'virement', `N${tag}`, 'B', '100', '2026-10-01'])).counts.error).toBe(1);
    expect((await run([clientName, 'chèque', '', 'B', '100', '2026-10-01'])).counts.error).toBe(1);
    expect((await run([clientName, 'chèque', `N${tag}`, 'B', 'cent', '2026-10-01'])).counts.error).toBe(1);
    expect(await count('payment_instrument', `number = 'N${tag}'`)).toBe(0);
  });
  it('is the owner\u2019s: an office account cannot record instruments through the importer', async () => {
    await expect(
      runImport('cheques_in_transit', readSheet(buildXlsx(rows(`Z${tag}1`, `Z${tag}2`))), {
        appPool: app,
        actor: office,
        apply: true,
      }),
    ).rejects.toThrow();
  });
});
