import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { readSheet } from '../src/modules/importer';
import { formatReport, runImport } from '../src/modules/importer/service/importers';
import {
  getOpeningState,
  listInstruments,
  listOpeningObligations,
  listOpeningOpenItems,
} from '../src/modules/ledger';
import { createPlant, updatePlant } from '../src/modules/master-data';
import { getStockLevels } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { buildXlsx } from './helpers/xlsx-writer';

// T19-close A (D246, migration 0251): the rest of the opening position: per-invoice open items (with the one-line fallback kept), loans and leasing with their
// instalments, opening stock per plant and component, and issued cheques that carry the dates of the sheet. Every row is marked opening_30_11, written by
// owner / app_admin through doors only, insert-only, idempotent on a second run.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));
let owner: SessionUser;
let office: SessionUser;
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
const tag = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
let opening = '2026-11-30';
const ctx = (apply: boolean, actor?: SessionUser) => ({
  appPool: app,
  actor: actor ?? owner,
  apply,
  openingDate: opening,
});
const run = (kind: Parameters<typeof runImport>[0], rows: (string | number)[][], apply: boolean) =>
  runImport(kind, readSheet(buildXlsx(rows)), ctx(apply));
const inCtx = <T>(who: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: who.id, role: who.role, requestId: tag }, fn);
beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  office = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office_purchases');
  opening = (await getOpeningState(app, owner)).openingDate ?? opening;
});

const client = `Client détail ${tag}`;
const clientB = `Client ligne ${tag}`;
const clientC = `Client fichier ${tag}`;
const supplier = `Fournisseur détail ${tag}`;
const head = ['Tiers', 'Code', 'Facture', 'Date facture', 'Échéance', 'Montant facture', 'Reste'];
describe('per-invoice open items', () => {
  const rows = [
    head,
    ['client', client, `F-${tag}-1`, '10/09/2026', '10/10/2026', '12 000,00', '12 000,00'],
    ['client', client, `F-${tag}-2`, '01/10/2026', '31/10/2026', '8 000,00', '3 500,50'],
    ['fournisseur', supplier, `A-${tag}-1`, '05/11/2026', '05/12/2026', '4 000,00', '4 000,00'],
  ];
  it('makes the party line from the items, reports the totals, marks the rows, and does not double', async () => {
    await run(
      'clients',
      [
        ['Nom', 'Type'],
        [client, 'société'],
        [clientB, 'société'],
      ],
      true,
    );
    await run(
      'suppliers',
      [
        ['Nom', 'Catégorie'],
        [supplier, 'other'],
      ],
      true,
    );
    const dry = await run('open_items', rows, false);
    expect(dry.counts).toMatchObject({ new: 3, error: 0 });
    // the totals control is the sum of the BALANCES
    expect(dry.totals).toMatchObject({
      rows: 3,
      writable: 3,
      fileCentimes: 1_950_050,
      writableCentimes: 1_950_050,
    });
    expect(formatReport(dry)).toContain('TOTALS CONTROL');
    expect((await listOpeningOpenItems(app, owner)).filter((i) => i.partyName.endsWith(tag))).toEqual([]);
    const real = await run('open_items', rows, true);
    expect(real.counts).toMatchObject({ created: 3, failed: 0 });
    const items = (await listOpeningOpenItems(app, owner)).filter((i) => i.partyName.endsWith(tag));
    expect(items).toHaveLength(3);
    const mine = items.filter((i) => i.partyName === client);
    expect(mine.map((i) => [i.invoiceNumber, i.dueDate, i.amountCentimes, i.balanceCentimes])).toEqual([
      [`F-${tag}-1`, '2026-10-10', 1_200_000, 1_200_000],
      [`F-${tag}-2`, '2026-10-31', 800_000, 350_050],
    ]);
    // the party's line is the sum of its balances, with a known age
    expect(mine[0]).toMatchObject({ lineCentimes: 1_550_050, itemsTotalCentimes: 1_550_050 });
    const state = await getOpeningState(app, owner);
    expect(state.parties.find((p) => p.partyName === client)).toMatchObject({
      amountCentimes: 1_550_050,
      agingUnknown: false,
    });
    const marks = await migrator.query(
      `select distinct source from opening_open_item where invoice_number like $1`,
      [`%-${tag}-%`],
    );
    expect(marks.rows).toEqual([{ source: 'opening_30_11' }]);
    expect((await run('open_items', rows, true)).counts).toMatchObject({ exists: 3, created: 0, error: 0 });
  });

  it('keeps the one-line fallback, and refuses what contradicts it', async () => {
    // a party without per-invoice detail: the single line, age unknown
    const line = await run(
      'opening_balances',
      [
        ['Tiers', 'Code', 'Montant'],
        ['client', clientB, '900,00'],
      ],
      true,
    );
    expect(line.counts).toMatchObject({ created: 1 });
    expect((await getOpeningState(app, owner)).parties.find((p) => p.partyName === clientB)).toMatchObject({
      agingUnknown: true,
    });
    // per-invoice detail for the same party is an alternative, never a second line
    const clash = await run(
      'open_items',
      [head, ['client', clientB, `F-${tag}-9`, '01/10/2026', '01/11/2026', '900,00', '900,00']],
      false,
    );
    expect(clash.counts.error).toBe(1);
    // a changed balance on a loaded invoice blocks the file instead of being skipped
    const changed = await run(
      'open_items',
      [head, ['client', client, `F-${tag}-2`, '01/10/2026', '31/10/2026', '8 000,00', '1 000,00']],
      false,
    );
    expect(changed.counts.error).toBe(1);
    await run(
      'clients',
      [
        ['Nom', 'Type'],
        [clientC, 'société'],
      ],
      true,
    );
    // file problems: balance above the invoice, due before the date, twice, unknown party, no date
    const bad = await run(
      'open_items',
      [
        head,
        ['client', clientC, `Z-${tag}-1`, '01/10/2026', '31/10/2026', '100,00', '200,00'],
        ['client', clientC, `Z-${tag}-2`, '01/10/2026', '30/09/2026', '100,00', '100,00'],
        ['client', clientC, `Z-${tag}-3`, '01/10/2026', '31/10/2026', '100,00', '50,00'],
        ['client', clientC, `Z-${tag}-3`, '01/10/2026', '31/10/2026', '100,00', '50,00'],
        ['client', 'Inconnu', `Z-${tag}-4`, '01/10/2026', '31/10/2026', '100,00', '50,00'],
        ['client', clientC, `Z-${tag}-5`, 'pas une date', '31/10/2026', '100,00', '50,00'],
      ],
      false,
    );
    expect(bad.counts.error).toBe(5);
    expect(bad.rows.filter((r) => r.status === 'error').map((r) => r.row)).toEqual([2, 3, 5, 6, 7]);
  });

  it('only owner and app_admin write, nobody edits or deletes, and the items never exceed the line', async () => {
    await expect(
      inCtx(office, (tx) =>
        tx.query(`select public.add_opening_open_item($1, null, 'X', '2026-01-01', '2026-02-01', 100, 100)`, [
          randomUUID(),
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inCtx(office, (tx) => tx.query('select * from public.opening_open_item')),
    ).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      inCtx(owner, (tx) => tx.query(`update public.opening_open_item set balance_centimes = 1`)),
    ).rejects.toThrow();
    // the line of the client is 1 550,50: a further invoice over it is refused by the door
    const cid = (await migrator.query<{ id: string }>(`select id from client where name = $1`, [client]))
      .rows[0]!.id;
    await expect(
      inCtx(owner, (tx) =>
        tx.query(`select public.add_opening_open_item($1, null, $2, '2026-10-01', '2026-11-01', 100, 100)`, [
          cid,
          `OVER-${tag}`,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('loans and leasing', () => {
  const ref1 = `PRET-${tag}`;
  const ref2 = `LEAS-${tag}`;
  const rows = [
    ['Contrat', 'Type', 'Organisme', 'Échéance', 'Montant'],
    [ref1, 'prêt', 'Banque test', '05/01/2027', '10 000,00'],
    [ref1, 'prêt', 'Banque test', '05/02/2027', '10 000,00'],
    [ref2, 'leasing', 'Société de leasing test', '15/01/2027', '7 500,25'],
  ];
  it('loads the schedule, totals it, marks it, and a second run changes nothing', async () => {
    const dry = await run('obligations', rows, false);
    expect(dry.counts).toMatchObject({ new: 3, error: 0 });
    expect(dry.totals).toMatchObject({ rows: 3, fileCentimes: 2_750_025 });
    expect((await listOpeningObligations(app, owner)).filter((o) => o.reference.endsWith(tag))).toEqual([]);
    const real = await run('obligations', rows, true);
    expect(real.counts).toMatchObject({ created: 3, failed: 0 });
    const made = (await listOpeningObligations(app, owner)).filter((o) => o.reference.endsWith(tag));
    expect(made.map((o) => [o.reference, o.kind, o.totalCentimes, o.instalments.length]).sort()).toEqual(
      [
        [ref2, 'leasing', 750_025, 1],
        [ref1, 'loan', 2_000_000, 2],
      ].sort(),
    );
    expect((await run('obligations', rows, true)).counts).toMatchObject({ exists: 3, created: 0 });
    // a later file adds the missing instalment of a contract that exists; a different amount on a loaded date blocks
    const more = [...rows.slice(0, 1), [ref1, 'prêt', 'Banque test', '05/03/2027', '10 000,00']];
    expect((await run('obligations', more, true)).counts).toMatchObject({ created: 1 });
    const changed = [rows[0]!, [ref1, 'prêt', 'Banque test', '05/01/2027', '9 000,00']];
    expect((await run('obligations', changed, false)).counts.error).toBe(1);
    const marks = await migrator.query(
      `select distinct source from opening_obligation where reference like $1`,
      [`%${tag}`],
    );
    expect(marks.rows).toEqual([{ source: 'opening_30_11' }]);
  });
  it('refuses a past instalment, an unknown type, a contract that changes lender, and an office role', async () => {
    const bad = await run(
      'obligations',
      [
        rows[0]!,
        [`B1-${tag}`, 'prêt', 'Banque', '05/01/2020', '100'],
        [`B2-${tag}`, 'hypothèque', 'Banque', '05/01/2027', '100'],
        [`B3-${tag}`, 'prêt', 'Banque A', '05/01/2027', '100'],
        [`B3-${tag}`, 'prêt', 'Banque B', '05/02/2027', '100'],
      ],
      false,
    );
    expect(bad.counts.error).toBe(3);
    await expect(
      inCtx(office, (tx) => tx.query(`select public.add_opening_obligation('loan', 'Banque', 'NOPE')`)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(runImport('obligations', readSheet(buildXlsx(rows)), ctx(true, office))).rejects.toThrow();
  });
});

describe('opening stock per plant and component', () => {
  const plantCode = letters(6);
  let plantId: string | null = null;
  // other suites expect no extra active plant: archive ours
  afterAll(async () => {
    if (plantId) await updatePlant(app, owner, plantId, { status: 'archived' });
  });
  const cement = `Ciment ouverture ${tag}`;
  const additive = `Adjuvant ouverture ${tag}`;
  it('writes signed opening movements per plant, dated the opening date, once', async () => {
    const plant = await createPlant(app, owner, { code: plantCode, name: `Centrale ouverture ${tag}` });
    expect(plant.ok).toBe(true);
    plantId = plant.ok ? plant.value.id : null;
    await run(
      'components',
      [
        ['Nom', 'Unité'],
        [cement, 'g'],
        [additive, 'mL'],
      ],
      true,
    );
    const rows = [
      ['Centrale', 'Composant', 'Quantité', 'Unité'],
      [plantCode, cement, '120000', 'kg'],
      [plantCode, additive, '350', 'L'],
    ];
    const dry = await run('opening_stock', rows, false);
    expect(dry.counts).toMatchObject({ new: 2, error: 0 });
    const real = await run('opening_stock', rows, true);
    expect(real.counts).toMatchObject({ created: 2, failed: 0 });
    const m = await migrator.query<{ qty: string; d: string; source: string }>(
      `select m.qty_base::text qty, m.movement_date::text d, m.source from stock_movement m
         join component c on c.id = m.component_id where c.name_fr = $1`,
      [cement],
    );
    expect(m.rows).toEqual([{ qty: '120000000', d: opening, source: 'opening' }]);
    const levels = await getStockLevels(app, owner, {
      plantId: (plant as { ok: true; value: { id: string } }).value.id,
    });
    expect(levels.find((l) => l.nameFr === additive)?.level).toBe(350_000);
    expect((await run('opening_stock', rows, true)).counts).toMatchObject({ exists: 2, created: 0 });
    // a different quantity for a loaded component blocks the file; a wrong date, a missing or unknown plant, an unknown component too
    const bad = await run(
      'opening_stock',
      [
        rows[0]!,
        [plantCode, cement, '1', 'kg'],
        [plantCode, `Inconnu ${tag}`, '1', 'kg'],
        ['ZZZZZZ', cement, '1', 'kg'],
        ['', additive, '1', 'L'],
      ],
      false,
    );
    expect(bad.counts.error).toBe(4);
    const dated = await run(
      'opening_stock',
      [
        [...rows[0]!, 'Date'],
        [plantCode, additive, '1', 'L', '01/12/2026'],
      ],
      false,
    );
    expect(dated.counts.error).toBe(1);
  });
});

describe('issued cheques carry the dates of the sheet', () => {
  it('keeps written date, due date and the handover day (the opening date, never the import day)', async () => {
    const sup = `Fournisseur effets ${tag}`;
    await run(
      'suppliers',
      [
        ['Nom', 'Catégorie'],
        [sup, 'other'],
      ],
      true,
    );
    const rows = [
      ['Fournisseur', 'Type', 'Numéro', 'Banque', 'Montant', 'Date', 'Échéance'],
      [sup, 'chèque', `CH${tag}1`, 'BMCE', '2 000,00', '20/12/2026', ''],
      [sup, 'LCN', `LC${tag}2`, 'BMCE', '3 000,00', '01/11/2026', '31/12/2026'],
    ];
    const real = await run('cheques_issued', rows, true);
    expect(real.counts).toMatchObject({ created: 2, failed: 0 });
    const list = (await listInstruments(app, owner)).filter((i) => i.partyName === sup);
    const cheque = list.find((i) => i.number === `CH${tag}1`)!;
    const lcn = list.find((i) => i.number === `LC${tag}2`)!;
    expect([cheque.writtenDate, cheque.dueDate, cheque.receivedDate]).toEqual(['2026-12-20', null, opening]);
    expect([lcn.writtenDate, lcn.dueDate, lcn.receivedDate]).toEqual(['2026-11-01', '2026-12-31', opening]);
    expect(lcn.events[0]).toMatchObject({ event: 'issued', atDate: opening });
    expect((await run('cheques_issued', rows, true)).counts).toMatchObject({ exists: 2, created: 0 });
    // an Échéance-only sheet works (the due date is the written date); a due date before the written date is refused
    const only = await run(
      'cheques_issued',
      [
        ['Fournisseur', 'Type', 'Numéro', 'Banque', 'Montant', 'Échéance'],
        [sup, 'chèque', `CH${tag}3`, 'BMCE', '10', '15/01/2027'],
      ],
      true,
    );
    expect(only.counts).toMatchObject({ created: 1 });
    const bad = await run(
      'cheques_issued',
      [rows[0]!, [sup, 'LCN', `LC${tag}4`, 'BMCE', '10', '01/12/2026', '01/11/2026']],
      false,
    );
    expect(bad.counts.error).toBe(1);
    const noDate = await run(
      'cheques_issued',
      [
        ['Fournisseur', 'Type', 'Numéro', 'Banque', 'Montant'],
        [sup, 'LCN', `LC${tag}5`, 'BMCE', '10'],
      ],
      false,
    );
    expect(noDate.counts.error).toBe(1);
  });
});
