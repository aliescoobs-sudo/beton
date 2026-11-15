import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  addOpeningOpenItem,
  getClientStatement,
  getSupplierStatement,
  listAccounts,
  receiveInstrument,
} from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { ensureOpening, moneyMaster } from './helpers/ledger-fixtures';

// T19c B1 (D245, D246, migration 0253): statements and the account list read the per-invoice opening items when a party has them, and the single
// opening line only when it has none; the lines always add up to the party's opening line (never both, never doubled).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
afterAll(() => app.end());
const marker = `orr${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const TODAY = '2026-12-15';
const users = {} as Record<'owner' | 'office_sales' | 'office_purchases' | 'plant', SessionUser>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);
let withItems = '';
let oneLine = '';
let supplierId = '';
beforeAll(async () => {
  for (const role of ['owner', 'office_sales', 'office_purchases', 'plant'] as const)
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  supplierId = (await moneyMaster(app, users.owner.id, marker)).supplierId;
  await ensureOpening(app, users.owner.id, marker);
  const mk = (table: 'client' | 'supplier', prefix: string) =>
    inCtx(
      users.owner,
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `insert into ${table} (id, code, name${table === 'client' ? ', kind' : ''}) values (gen_random_uuid(), public.next_code('${prefix}', 3), $1${table === 'client' ? ", 'person'" : ''}) returning id`,
            [`${marker} ${table} ${randomUUID()}`],
          )
        ).rows[0]!.id,
    );
  withItems = await mk('client', 'CLT');
  oneLine = await mk('client', 'CLT');
  const line = (col: string, id: string, amount: number) =>
    inCtx(users.owner, (tx) =>
      tx.query(
        `insert into opening_party_balance (id, ${col}, amount_centimes, created_by) values (gen_random_uuid(), $1, $2, $3)`,
        [id, amount, users.owner.id],
      ),
    );
  await line('client_id', withItems, 150_000); // 1 000,00 + 500,00
  await line('client_id', oneLine, 90_000);
  await line('supplier_id', supplierId, 40_000);
  const item = (extra: object) =>
    addOpeningOpenItem(app, users.owner, { invoiceDate: '2026-09-01', ...extra }).then((r) => {
      expect(r.ok).toBe(true);
    });
  await item({
    clientId: withItems,
    invoiceNumber: `${marker}-1`,
    dueDate: '2026-10-01',
    amountCentimes: 100_000,
    balanceCentimes: 100_000,
  });
  await item({
    clientId: withItems,
    invoiceNumber: `${marker}-2`,
    dueDate: '2027-01-10',
    amountCentimes: 80_000,
    balanceCentimes: 50_000,
  });
  await item({
    supplierId,
    invoiceNumber: `${marker}-S1`,
    dueDate: '2026-11-20',
    amountCentimes: 40_000,
    balanceCentimes: 40_000,
  });
});

const opening = (s: NonNullable<Awaited<ReturnType<typeof getClientStatement>>>) =>
  s.statement.commercial.filter((r) => r.type === 'opening');

describe('statements read the per-invoice items', () => {
  it('a party with items shows one line per invoice and no single line; the closing is the opening line; what is past due is the items past due', async () => {
    const s = (await getClientStatement(app, users.owner, withItems, {}, { today: TODAY }))!;
    expect(opening(s).map((r) => [r.code, Number(r.amountCentimes)])).toEqual([
      [`${marker}-1`, 100_000],
      [`${marker}-2`, 50_000],
    ]);
    expect(Number(s.statement.closing)).toBe(150_000);
    expect(Number(s.statement.summary.late)).toBe(100_000);
    expect(Number(s.statement.summary.due)).toBe(50_000);
    expect(s.statement.summary.nextDueDate).toBe('2027-01-10');
  });

  it('a party without items keeps its single line (age unknown) and nothing is late', async () => {
    const s = (await getClientStatement(app, users.owner, oneLine, {}, { today: TODAY }))!;
    expect(opening(s).map((r) => [r.code, Number(r.amountCentimes)])).toEqual([[null, 90_000]]);
    expect(Number(s.statement.closing)).toBe(90_000);
    expect(Number(s.statement.summary.late)).toBe(0);
  });

  it('a payment no plan item took is applied to the oldest item, the balance drops by it, and the lines are not touched', async () => {
    const r = await receiveInstrument(
      app,
      users.office_sales,
      { method: 'cash', amountCentimes: 30_000, clientId: withItems },
      { today: '2026-12-01' },
    );
    expect(r.ok).toBe(true);
    const s = (await getClientStatement(app, users.owner, withItems, {}, { today: TODAY }))!;
    expect(opening(s).map((x) => Number(x.amountCentimes))).toEqual([100_000, 50_000]);
    expect(Number(s.statement.closing)).toBe(120_000);
    expect(Number(s.statement.summary.late)).toBe(70_000); // 1 000,00 minus the 300,00 received, oldest first
  });

  it('the account list agrees with the statements, per side', async () => {
    const sales = await listAccounts(app, users.office_sales, { today: TODAY });
    expect(sales.every((a) => a.kind === 'client')).toBe(true);
    expect(sales.find((a) => a.partyId === withItems)).toMatchObject({
      balanceCentimes: 120_000,
      lateCentimes: 70_000,
    });
    expect(sales.find((a) => a.partyId === oneLine)).toMatchObject({
      balanceCentimes: 90_000,
      lateCentimes: 0,
    });
    const purchases = await listAccounts(app, users.office_purchases, { today: TODAY });
    expect(purchases.every((a) => a.kind === 'supplier')).toBe(true);
    expect(purchases.find((a) => a.partyId === supplierId)).toMatchObject({
      balanceCentimes: 40_000,
      lateCentimes: 40_000,
    });
    const st = (await getSupplierStatement(app, users.office_purchases, supplierId, {}, { today: TODAY }))!;
    expect(opening(st).map((r) => r.code)).toEqual([`${marker}-S1`]);
  });
});

describe('the door opening_items_read is side-scoped, actor first', () => {
  const call = (who: SessionUser, kind: string, ids: string[]) =>
    inCtx(who, (tx) => tx.query('select * from public.opening_items_read($1, $2::uuid[])', [kind, ids])).then(
      (r) => r.rows.length,
      (e: { code?: string }) => e.code,
    );
  it('owner reads both sides, the Responsable clients only, the Assistante suppliers only, nobody else', async () => {
    expect(await call(users.owner, 'client', [withItems])).toBe(2);
    expect(await call(users.owner, 'supplier', [supplierId])).toBe(1);
    expect(await call(users.office_sales, 'client', [withItems])).toBe(2);
    expect(await call(users.office_sales, 'supplier', [supplierId])).toBe('42501');
    expect(await call(users.office_purchases, 'supplier', [supplierId])).toBe(1);
    expect(await call(users.office_purchases, 'client', [withItems])).toBe('42501');
    expect(await call(users.plant, 'client', [withItems])).toBe('42501');
    expect(await call(users.owner, 'other', [withItems])).toBe('23514');
    // a party of the other kind never leaks through the kind argument
    expect(await call(users.owner, 'supplier', [withItems])).toBe(0);
  });
});
