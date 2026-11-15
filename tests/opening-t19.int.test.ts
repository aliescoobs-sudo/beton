import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { readSheet } from '../src/modules/importer';
import { formatReport, runImport } from '../src/modules/importer/service/importers';
import { createMoneyAccount, getDocCounter, setDocCounter } from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { buildXlsx } from './helpers/xlsx-writer';

// T19 item 3 (D246, migration 0242): the rest of the opening position: counters, cash and bank, outstanding issued cheques; every row marked
// source = 'opening_30_11'; a dry run with a totals control; the counters only move forward; an office role can neither mark a row nor run the importer.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));
let owner: SessionUser;
let office: SessionUser;
const tag = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const ctx = (apply: boolean, actor?: SessionUser) => ({ appPool: app, actor: actor ?? owner, apply });
const count = async (table: string, where = 'true') =>
  Number(
    (await migrator.query<{ n: string }>(`select count(*)::text as n from ${table} where ${where}`)).rows[0]
      ?.n,
  );
beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  office = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office_sales');
});

describe('document counters', () => {
  const year = 2400 + Math.floor(Math.random() * 500);
  const rows = (bl: number, cmd: number) => [
    ['Série', 'Année', 'Dernier numéro'],
    ['BL', year, bl],
    ['CMD', year, cmd],
  ];
  it('continues the paper series, only forward; a second run changes nothing', async () => {
    const dry = await runImport('doc_counters', readSheet(buildXlsx(rows(4120, 310))), ctx(false));
    expect(dry.counts).toMatchObject({ new: 2, error: 0 });
    expect(await getDocCounter(app, owner, 'BL', year)).toBeNull();
    const real = await runImport('doc_counters', readSheet(buildXlsx(rows(4120, 310))), ctx(true));
    expect(real.counts).toMatchObject({ created: 2 });
    expect(await getDocCounter(app, owner, 'BL', year)).toBe(4120);
    expect(
      (await runImport('doc_counters', readSheet(buildXlsx(rows(4120, 310))), ctx(true))).counts,
    ).toMatchObject({ exists: 2, created: 0 });
    // backwards is refused, in the file and by the door
    expect(
      (await runImport('doc_counters', readSheet(buildXlsx(rows(100, 310))), ctx(true))).counts.error,
    ).toBe(1);
    expect((await setDocCounter(app, owner, { prefix: 'BL', year, last: 50 })).ok).toBe(false);
    expect((await setDocCounter(app, owner, { prefix: 'XX', year, last: 50 })).ok).toBe(false);
    // the next BL number of that year follows the paper
    const next = await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: tag }, (tx) =>
      tx.query<{ n: string }>(`select public.next_doc_number('BL', $1, 5) as n`, [year]),
    );
    expect(next.rows[0]?.n).toBe(`BL-${year}-04121`);
  });
});

describe('cash and bank opening, outstanding issued cheques', () => {
  const label = `Banque ouverture ${tag}`;
  const supplier = `Fournisseur ouverture ${tag}`;
  it('marks every opening row, reports totals before writing, and does not double', async () => {
    const acc = await createMoneyAccount(app, owner, { kind: 'bank', label, bankName: 'Banque test' });
    expect(acc.ok).toBe(true);
    await runImport(
      'suppliers',
      readSheet(
        buildXlsx([
          ['Nom', 'Catégorie'],
          [supplier, 'other'],
        ]),
      ),
      ctx(true),
    );

    const bal = [
      ['Compte', 'Date', 'Montant'],
      [label, '30/11/2026', '125 000,50'],
    ];
    const dryBal = await runImport('account_balances', readSheet(buildXlsx(bal)), ctx(false));
    expect(dryBal.totals).toMatchObject({
      rows: 1,
      writable: 1,
      fileCentimes: 12_500_050,
      writableCentimes: 12_500_050,
    });
    expect(formatReport(dryBal)).toContain('TOTALS CONTROL');
    expect(await count('opening_balance', `source = 'opening_30_11'`)).toBeGreaterThanOrEqual(0);
    const realBal = await runImport('account_balances', readSheet(buildXlsx(bal)), ctx(true));
    expect(realBal.counts).toMatchObject({ created: 1 });
    const mine = await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: tag }, (tx) =>
      tx.query(
        `select source, amount_centimes::text a, as_of::text d from opening_balance where account_id in (select id from money_account where label = $1)`,
        [label],
      ),
    );
    expect(mine.rows).toEqual([{ source: 'opening_30_11', a: '12500050', d: '2026-11-30' }]);
    expect((await runImport('account_balances', readSheet(buildXlsx(bal)), ctx(true))).counts).toMatchObject({
      exists: 1,
      created: 0,
    });

    const n1 = `OUT${tag}1`;
    const chq = [
      ['Fournisseur', 'Type', 'Numéro', 'Banque', 'Montant', 'Date'],
      [supplier, 'chèque', n1, 'BMCE', '4 000,00', '15/12/2026'],
      [supplier, 'LCN', `OUT${tag}2`, 'BMCE', '1000', '2026-12-20'],
    ];
    const dry = await runImport('cheques_issued', readSheet(buildXlsx(chq)), ctx(false));
    expect(dry.totals).toMatchObject({ rows: 2, writable: 2, fileCentimes: 500_000 });
    expect(await count('payment_instrument', `number like 'OUT${tag}%'`)).toBe(0);
    const real = await runImport('cheques_issued', readSheet(buildXlsx(chq)), ctx(true));
    expect(real.counts).toMatchObject({ created: 2, failed: 0 });
    const rows = await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: tag }, (tx) =>
      tx.query(
        `select direction, source, written_date::text w from payment_instrument where number like 'OUT${tag}%' order by number`,
      ),
    );
    expect(rows.rows).toEqual([
      { direction: 'out', source: 'opening_30_11', w: '2026-12-15' },
      { direction: 'out', source: 'opening_30_11', w: '2026-12-20' },
    ]);
    expect((await runImport('cheques_issued', readSheet(buildXlsx(chq)), ctx(true))).counts).toMatchObject({
      exists: 2,
      created: 0,
    });
    // an unknown supplier blocks the file
    const bad = [chq[0]!, ['Inconnu', 'chèque', 'Z1', 'B', '10', '2026-12-01']];
    expect((await runImport('cheques_issued', readSheet(buildXlsx(bad)), ctx(false))).counts.error).toBe(1);
  });
});

describe('who may mark and who may import', () => {
  it('an office role cannot run the importer and cannot mark a row as an opening row', async () => {
    await expect(
      runImport(
        'doc_counters',
        readSheet(
          buildXlsx([
            ['Série', 'Année', 'Dernier numéro'],
            ['BL', 2999, 5],
          ]),
        ),
        ctx(true, office),
      ),
    ).rejects.toThrow();
    await expect(
      withRlsContext(app, { userId: office.id, role: 'office_sales', requestId: tag }, (tx) =>
        tx.query(
          `insert into payment_instrument (id, direction, method, amount_centimes, supplier_id, received_date, created_by, source)
           values (gen_random_uuid(), 'out', 'cash', 100, (select id from supplier limit 1), '2026-11-30', $1, 'opening_30_11')`,
          [office.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withRlsContext(app, { userId: office.id, role: 'office_sales', requestId: tag }, (tx) =>
        tx.query(`select public.set_doc_counter('BL', 2998, 1)`),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
