import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { realClock } from '../src/modules/clock';
import { uuidv7 } from '../src/lib/uuidv7';
import {
  createMoneyAccount,
  clearInstrument,
  setOpeningBalance,
  createPurchase,
} from '../src/modules/ledger';
import { createPlant, updatePlant, type Plant } from '../src/modules/master-data';
import { type SessionUser, inPlant } from '../src/modules/platform-security';
import {
  executeFinance,
  getFinanceCash,
  getFinanceReport,
  exportAccountant,
  type FinanceSession,
} from '../src/modules/finance';
import { recordFuelFill } from '../src/modules/operations';
import { FINANCE_TABLES } from '../src/modules/finance/domain/table-access';
import { SCENARIO_TEST_DATABASE, recreateDatabase } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import { seedPilotMasterData } from '../src/modules/master-data';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import {
  deliveryScene,
  insertDelivery,
  insertOrder,
  orderMaster,
  insertInvoice,
  moneyMaster,
  insertInstrument,
  purchaseMaster,
} from './helpers/ledger-fixtures';
const env = testEnv(SCENARIO_TEST_DATABASE),
  app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 }),
  migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = 'fn' + randomUUID().replace(/-/g, '').slice(0, 10);
let owner: SessionUser,
  cashId: string,
  bankId: string,
  supplierId: string,
  A: Plant,
  B: Plant,
  scene: Awaited<ReturnType<typeof deliveryScene>>;
const actors: SessionUser[] = [];
/** R3 state: the order carries a provisional price that the owner has not confirmed yet (written the way a definer door would, audited). */
async function markProvisional(orderId: string) {
  const c = await migrator.connect();
  try {
    await c.query('BEGIN');
    await c.query(`select set_config('app.user_id', $1, true), set_config('app.role', 'owner', true)`, [
      owner.id,
    ]);
    await c.query(
      `insert into order_price_status(order_id, provisional_unit_price_centimes, created_by) values($1, 78000, $2) on conflict do nothing`,
      [orderId, owner.id],
    );
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}
const session = (): FinanceSession => ({ user: owner, twoFactorAt: realClock.now() });
const cmd = (v: unknown) => executeFinance(app, session(), v);
const run = <T>(actor: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: actor.id, role: actor.role, requestId: marker }, fn);
beforeAll(async () => {
  // Finance owns its test data: the legacy R1 stock assertions assume only their own two plants.
  await recreateDatabase(env, SCENARIO_TEST_DATABASE);
  await runMigrations(env.DATABASE_URL_MIGRATOR);
  const seed = new pg.Pool({ connectionString: env.DATABASE_URL_SEED, max: 1 });
  try {
    await seedPilotMasterData(seed, { SIMULATION_ENABLED: true, REAL_DATA: false, NODE_ENV: 'test' });
  } finally {
    await seed.end();
  }

  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  for (const role of ['partner', 'office', 'plant', 'support'] as const)
    actors.push(await realSessionUser(env.DATABASE_URL_MIGRATOR, role));
  const a = await createPlant(app, owner, {
    code:
      marker
        .slice(0, 6)
        .replace(/[^a-z]/g, 'X')
        .toUpperCase() + 'A',
    name: 'Finance A ' + marker,
  });
  if (!a.ok) throw new Error(a.error);
  A = a.value;
  scene = await deliveryScene(app, owner.id, marker);
  const b = await createPlant(app, owner, { code: A.code.slice(0, -1) + 'B', name: 'Finance B ' + marker });
  if (!b.ok) throw new Error(b.error);
  B = b.value;
  const account = await createMoneyAccount(app, owner, { kind: 'cash', label: 'Finance cash ' + marker });
  if (!account.ok) throw new Error(account.error);
  cashId = account.value.id;
  const opening = await setOpeningBalance(app, owner, {
    accountId: cashId,
    asOf: '2026-01-01',
    amountCentimes: 123456,
  });
  if (!opening.ok) throw new Error(opening.error);
  const mm = await moneyMaster(app, owner.id, marker);
  bankId = mm.bankId;
  supplierId = mm.supplierId;
  await cmd({ action: 'configure', enabled: true, leasingTreatment: 'expense' });
});
afterAll(async () => {
  if (owner) await cmd({ action: 'configure', enabled: false, leasingTreatment: 'expense' });
  for (const p of [A, B]) if (p) await updatePlant(app, owner, p.id, { status: 'archived' });
  await Promise.all([app.end(), migrator.end()]);
});
describe('finance schema security, source doors and audit exposure', () => {
  it('registers every table, forces RLS, audits writes and grants no mutating or seed/system privileges', async () => {
    const rows = (
      await migrator.query<{
        name: string;
        rls: boolean;
        forced: boolean;
        audited: boolean;
        mutation: boolean;
        seed: boolean;
        system: boolean;
      }>(
        `select c.relname name,c.relrowsecurity rls,c.relforcerowsecurity forced,exists(select 1 from pg_trigger t where t.tgrelid=c.oid and t.tgname='audit_capture') audited,has_table_privilege('belgobeton_app',c.oid,'UPDATE,DELETE,TRUNCATE') mutation,has_table_privilege('belgobeton_seed',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') seed,has_table_privilege('belgobeton_system',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') system from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='finance' and c.relkind='r'`,
      )
    ).rows;
    expect(rows.map((r) => r.name).sort()).toEqual([...FINANCE_TABLES].sort());
    for (const r of rows) {
      expect(r).toMatchObject({
        rls: true,
        forced: true,
        audited: true,
        mutation: false,
        seed: false,
        system: false,
      });
    }
  });
  it('opening cash is included once and append-only triggers also protect the schema owner', async () => {
    const cash = await getFinanceCash(app, owner, '2026-11-01', '2026-11-30');
    expect(cash.accounts.find((a) => a.id === cashId)?.balanceCentimes).toBe(123456);
    await expect(migrator.query('truncate finance.finance_setting')).rejects.toMatchObject({ code: '42501' });
  });
  it('non-money roles see neither finance rows nor money in audit, and cannot call a source/export door', async () => {
    for (const actor of actors) {
      await run(actor, async (tx) => {
        for (const table of FINANCE_TABLES)
          expect((await tx.query(`select * from finance.${table}`)).rowCount).toBe(0);
        expect(
          (await tx.query(`select * from audit_event where left(table_name,8)='finance_'`)).rowCount,
        ).toBe(0);
      });
      for (const fn of [
        "finance.source_sales('2026-01-01','2026-12-31')",
        "finance.source_consumption('2026-01-01','2026-12-31')",
        "finance.source_fuel('2026-01-01','2026-12-31')",
        "finance.source_accounts('2026-12-31')",
        'finance.source_flows()',
        "finance.accounting_journal('2026-01-01','2026-12-31')",
      ]) {
        await expect(run(actor, (tx) => tx.query('select ' + fn))).rejects.toMatchObject({ code: '42501' });
      }
    }
  });
  it('an absent context fails closed in every definer door; guessed-amount inserts fail at authorization first', async () => {
    for (const fn of [
      "finance.source_sales('2026-01-01','2026-12-31')",
      "finance.source_accounts('2026-12-31')",
      'finance.source_flows()',
      "finance.accounting_journal('2026-01-01','2026-12-31')",
    ]) {
      await expect(app.query('select ' + fn)).rejects.toMatchObject({ code: '42501' });
    }
    for (const actor of actors)
      await expect(
        run(actor, (tx) =>
          tx.query(
            `insert into finance.finance_entry(id,entry_date,kind,amount_centimes,source_ref,created_by) values($1,'2026-06-01','expense',1,$2,$3)`,
            [randomUUID(), marker + randomUUID(), actor.id],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
  });
  it('requires fresh TOTP at service and verified context at database', async () => {
    await expect(
      executeFinance(
        app,
        { user: owner, twoFactorAt: null },
        { action: 'category', code: 'x' + marker, label: 'x', nature: 'fixed', kind: 'expense' },
      ),
    ).rejects.toThrow('STEP_UP_REQUIRED');
    await expect(
      run(owner, (tx) =>
        tx.query(
          `insert into finance.finance_category(id,code,label,nature,kind,created_by) values($1,$2,'x','fixed','expense',$3)`,
          [randomUUID(), marker, owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('flag off hides source doors, preserves other modules and can be changed only by the owner', async () => {
    await cmd({ action: 'configure', enabled: false, leasingTreatment: 'expense' });
    await expect(getFinanceCash(app, owner, '2026-06-01', '2026-06-30')).rejects.toThrow(
      'FINANCE_UNAVAILABLE',
    );
    for (const actor of actors)
      await expect(
        executeFinance(
          app,
          { user: actor, twoFactorAt: realClock.now() },
          { action: 'configure', enabled: true, leasingTreatment: 'expense' },
        ),
      ).rejects.toThrow('FINANCE_UNAVAILABLE');
    await cmd({ action: 'configure', enabled: true, leasingTreatment: 'expense' });
  });
});
describe('report and recorded commitments', () => {
  it('shares charges exactly between plants, keeps central costs separate, reverses without deleting', async () => {
    const key = await cmd({
      action: 'allocation',
      label: 'Pump key ' + marker,
      weights: { [A.id]: 1, [B.id]: 1 },
    });
    const entry = await cmd({
      action: 'entry',
      date: '2026-06-01',
      dueDate: '2026-06-10',
      kind: 'expense',
      amountCentimes: 1001,
      allocationId: key.id,
      reference: 'shared:' + marker,
    });
    const r = await getFinanceReport(app, owner, '2026-06-01', '2026-06-30');
    expect(r.total.costsCentimes).toBeGreaterThanOrEqual(1001);
    expect(r.plants.find((p) => p.plantId === A.id)?.costsCentimes).toBeGreaterThanOrEqual(500);
    await cmd({ action: 'reverse', entryId: entry.id, date: '2026-06-02', reason: 'Correction' });
    const after = await getFinanceReport(app, owner, '2026-06-01', '2026-06-30');
    expect(r.total.costsCentimes - after.total.costsCentimes).toBe(1001);
    expect(
      (await migrator.query('select * from finance.finance_entry where id=$1 or reverses_id=$1', [entry.id]))
        .rowCount,
    ).toBe(2);
    await expect(
      cmd({ action: 'reverse', entryId: entry.id, date: '2026-06-03', reason: 'Again' }),
    ).rejects.toThrow();
  });
  it('consumption needs evidenced valuation; material purchases do not enter the management result', async () => {
    const d = await run(owner, (tx) => insertDelivery(tx, owner.id, scene, 1000));
    await run(owner, (tx) => insertInvoice(tx, owner.id, scene, d, 'Finance client ' + marker, 1000));
    await markProvisional(scene.orderId); // R3: only a confirmed price counts as revenue; this order's is still provisional
    const missing = await getFinanceReport(app, owner, '2026-06-01', '2026-06-30');
    expect(missing.missingValuations).toBeGreaterThan(0);
    expect(missing.complete).toBe(false);
    expect(missing.excludedRevenueCentimes).toBeGreaterThan(0);
    const moves = (
      await migrator.query<{ id: string }>(
        `select id from stock_movement where source='delivery' and source_id=$1`,
        [d.id],
      )
    ).rows;
    for (const m of moves)
      await cmd({
        action: 'valueMaterial',
        movementId: m.id,
        priceCentimes: 100,
        priceBaseQty: 1000000,
        reference: 'validated supplier cost ' + marker,
      });
    const valued = await getFinanceReport(app, owner, '2026-06-01', '2026-06-30');
    expect(valued.missingValuations).toBe(missing.missingValuations - moves.length);
    expect(valued.total.costsCentimes).toBeGreaterThan(missing.total.costsCentimes);
    const master = await purchaseMaster(app, owner.id, marker + 'purchase');
    const purchase = await createPurchase(
      app,
      inPlant(owner, A.id),
      {
        supplierId: master.supplierId,
        lines: [
          {
            componentId: master.componentId,
            purchaseUnitId: master.unitId,
            qtyMilli: 1000,
            unitPriceHtCentimes: 145000,
          },
        ],
      },
      { today: '2026-06-01' },
    );
    expect(purchase.ok).toBe(true);
    const afterPurchase = await getFinanceReport(app, owner, '2026-06-01', '2026-06-30');
    expect(afterPurchase.total.costsCentimes).toBe(valued.total.costsCentimes);
    const avoir = await run(owner, async (tx) => {
      await tx.query(
        `insert into delivery_loss(id,delivery_id,volume_l,reason,created_by) values($1,$2,200,'rejected_by_client',$3)`,
        [randomUUID(), d.id, owner.id],
      );
      return (
        await tx.query<{ number: string }>(
          `select public.issue_avoir($1,'Finance test rejection','2026-06-03') number`,
          [d.id],
        )
      ).rows[0]!.number;
    });
    const journal = await exportAccountant(app, owner, '2026-06-01', '2026-06-30');
    expect(journal.toString()).toContain(avoir);
    expect(journal.subarray(0, 2).toString()).toBe('PK');
  });
  it('fuel is charged on dispensing with an evidenced cost, not on tank purchases', async () => {
    // Explicit plant context is required with two plants.
    const fill = await recordFuelFill(
      app,
      { ...owner, plantId: A.id },
      { truckId: scene.truckId, filledOn: '2026-06-10', litres: '10', source: 'tank' },
    );
    if (!fill.ok) throw new Error(fill.error);
    const before = await getFinanceReport(app, owner, '2026-06-01', '2026-06-30');
    await cmd({
      action: 'valueFuel',
      fillId: fill.value.id,
      pricePerLitreCentimes: 1234,
      reference: 'Weighted fuel cost ' + marker,
    });
    const after = await getFinanceReport(app, owner, '2026-06-01', '2026-06-30');
    expect(after.total.costsCentimes - before.total.costsCentimes).toBe(12340);
    expect(after.missingValuations).toBe(before.missingValuations - 1);
  });
  it('concurrent settlements cannot overpay one commitment', async () => {
    const obligation = await cmd({
      action: 'obligation',
      date: '2026-11-10',
      direction: 'out',
      amountCentimes: 1000,
      reference: 'concurrent:' + marker,
      label: 'Concurrent test',
    });
    const attempts = await Promise.allSettled(
      [1, 2].map((i) =>
        cmd({
          action: 'payment',
          obligationId: obligation.id,
          date: '2026-11-10',
          amountCentimes: 700,
          accountId: cashId,
          reference: 'concurrent:' + marker + ':' + i,
        }),
      ),
    );
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect(
      Number(
        (
          await migrator.query<{ amount: string }>(
            'select sum(amount_centimes)::text amount from finance.finance_payment where obligation_id=$1',
            [obligation.id],
          )
        ).rows[0]?.amount,
      ),
    ).toBe(700);
  });
  it('steel brings actual cash on delivery; supplier cheques start a month later and the loss is a central financing cost', async () => {
    const before = await getFinanceCash(app, owner, '2026-11-01', '2027-02-28');
    const deal = await cmd({
      action: 'steel',
      date: '2026-11-02',
      cashCentimes: 90000,
      purchaseCentimes: 100000,
      chequeCount: 3,
      accountId: cashId,
      reference: 'Steel ' + marker,
    });
    const obligations = (
      await migrator.query<{ source_ref: string; due_date: string; amount_centimes: string }>(
        `select source_ref,to_char(due_date,'YYYY-MM-DD') due_date,amount_centimes::text from finance.finance_obligation where source_ref like $1 order by due_date`,
        ['steel:%' + deal.id + '%'],
      )
    ).rows;
    expect(obligations.map((o) => o.due_date)).toEqual([
      '2026-11-02',
      '2026-12-02',
      '2027-01-02',
      '2027-02-02',
    ]);
    const after = await getFinanceCash(app, owner, '2026-11-01', '2027-02-28');
    expect(
      after.scheduled.days.find((d) => d.date === '2026-11-02')!.balanceCentimes -
        before.scheduled.days.find((d) => d.date === '2026-11-02')!.balanceCentimes,
    ).toBe(90000);
    expect(after.scheduled.days.at(-1)!.balanceCentimes - before.scheduled.days.at(-1)!.balanceCentimes).toBe(
      -10000,
    );
    const report = await getFinanceReport(app, owner, '2026-11-01', '2026-11-30');
    expect(report.central.costsCentimes).toBeGreaterThanOrEqual(10000);
    await expect(
      cmd({
        action: 'steel',
        date: '2026-11-02',
        cashCentimes: 90000,
        purchaseCentimes: 100000,
        chequeCount: 3,
        accountId: bankId,
        reference: 'Invalid bank ' + marker,
      }),
    ).rejects.toThrow();
  });
  it('a loan separates cash principal, installment and cost, and refuses an unbalanced schedule atomically', async () => {
    const v = {
      action: 'facility',
      kind: 'bank',
      label: 'Loan ' + marker,
      date: '2026-11-01',
      principalCentimes: 10000,
      accountId: bankId,
      schedule: [{ date: '2026-12-01', principalCentimes: 10000, costCentimes: 1000 }],
    };
    const facility = await cmd(v);
    const rows = (
      await migrator.query<{ kind: string; amount_centimes: string }>(
        'select kind,amount_centimes::text from finance.finance_entry where source_ref like $1',
        ['facility:%' + facility.id + '%'],
      )
    ).rows;
    expect(rows.map((r) => r.kind).sort()).toEqual(['financing', 'principal']);
    await expect(cmd({ ...v, label: 'Bad ' + marker, principalCentimes: 10001 })).rejects.toThrow();
    expect(
      (await migrator.query('select 1 from finance.finance_facility where label=$1', ['Bad ' + marker]))
        .rowCount,
    ).toBe(0);
  });
  it('a linked partial cheque and its installment are one cash commitment, before and after clearing', async () => {
    const obligation = await cmd({
      action: 'obligation',
      date: '2026-12-10',
      direction: 'out',
      amountCentimes: 10000,
      reference: 'link:' + marker,
      label: 'Lease ' + marker,
    });
    const paper = await run(owner, (tx) =>
      insertInstrument(tx, owner.id, {
        direction: 'out',
        method: 'cheque',
        amountCentimes: 4000,
        supplierId,
        receivedDate: '2026-11-01',
        writtenDate: '2026-12-10',
      }),
    );
    await cmd({ action: 'link', obligationId: obligation.id, instrumentId: paper.id });
    const cash = await getFinanceCash(app, owner, '2026-11-01', '2026-12-31');
    const { canonicalFlows } = await import('../src/modules/finance/domain/forecast');
    const flows = canonicalFlows(cash.flows).filter((f) => f.commitmentId === obligation.id);
    expect(flows.reduce((s, f) => s + f.amountCentimes, 0)).toBe(10000);
    const cleared = await clearInstrument(app, owner, {
      instrumentId: paper.id,
      accountId: bankId,
      date: '2026-12-10',
    });
    expect(cleared.ok).toBe(true);
    const after = await getFinanceCash(app, owner, '2026-11-01', '2026-12-31');
    expect(
      after.flows.filter((f) => f.commitmentId === obligation.id).reduce((s, f) => s + f.amountCentimes, 0),
    ).toBe(6000);
  });
  it('a cash-holder transfer is atomic and changes no company-wide cash or management result', async () => {
    const before = await getFinanceCash(app, owner, '2026-11-01', '2026-11-30');
    await cmd({
      action: 'transfer',
      fromAccountId: cashId,
      toAccountId: bankId,
      date: '2026-11-03',
      amountCentimes: 500,
      reference: 'transfer:' + marker,
    });
    const after = await getFinanceCash(app, owner, '2026-11-01', '2026-11-30');
    expect(after.scheduled.days.at(-1)!.balanceCentimes).toBe(before.scheduled.days.at(-1)!.balanceCentimes);
  });
});

// C1: finance wired to the V1 roles (R2) and to the confirmed price of R3 (order_price_status).
describe('R2 roles and R3 confirmed price', () => {
  const asRole = async (role: string) => {
    if (role !== 'plant_manager') return realSessionUser(env.DATABASE_URL_MIGRATOR, role as never);
    const id = uuidv7(realClock.now());
    await migrator.query(
      `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt", "plantId")
       values ($1, $2, $3, true, 'plant_manager', 'fr', 'active', true, now(), $4)`,
      [id, 'Finance plant manager', `${marker}-pm-${id}@belgobeton.test`, A.id],
    );
    return {
      id,
      name: 'Finance plant manager',
      email: `${marker}-pm@belgobeton.test`,
      role: 'plant_manager' as never,
      locale: 'fr' as const,
      twoFactorEnabled: true,
      reenrolRequired: false,
    };
  };
  it('app_admin works as the owner does; the accountant exports only; every other V1 role is shut out', async () => {
    const admin = await asRole('app_admin');
    await run(admin, async (tx) => {
      expect((await tx.query("select finance.source_sales('2026-01-01','2026-12-31')")).rowCount).toBe(1);
      expect((await tx.query('select finance.source_flows()')).rowCount).toBe(1);
    });
    const accountant = await asRole('accountant');
    await run(accountant, async (tx) => {
      expect((await tx.query("select finance.accounting_journal('2026-01-01','2026-12-31')")).rowCount).toBe(
        1,
      );
      for (const table of FINANCE_TABLES)
        expect((await tx.query(`select * from finance.${table}`)).rowCount).toBe(0);
    });
    for (const fn of [
      "finance.source_sales('2026-01-01','2026-12-31')",
      "finance.source_consumption('2026-01-01','2026-12-31')",
      "finance.source_fuel('2026-01-01','2026-12-31')",
      "finance.source_accounts('2026-12-31')",
      'finance.source_flows()',
    ])
      await expect(run(accountant, (tx) => tx.query('select ' + fn))).rejects.toMatchObject({
        code: '42501',
      });
    for (const role of [
      'office_sales',
      'office_purchases',
      'plant_manager',
      'driver',
      'pump_operator',
      'client_portal',
      'supplier_portal',
    ]) {
      const actor = await asRole(role);
      await run(actor, async (tx) => {
        for (const table of FINANCE_TABLES)
          expect((await tx.query(`select * from finance.${table}`)).rowCount).toBe(0);
        expect(
          (await tx.query(`select * from audit_event where left(table_name,8)='finance_'`)).rowCount,
        ).toBe(0);
      });
      for (const fn of [
        "finance.source_sales('2026-01-01','2026-12-31')",
        "finance.accounting_journal('2026-01-01','2026-12-31')",
        'finance.source_flows()',
      ])
        await expect(
          run(actor, (tx) => tx.query('select ' + fn)),
          role + ' ' + fn,
        ).rejects.toMatchObject({
          code: '42501',
        });
    }
  });
  it('a provisional price stays out of confirmed revenue until the owner confirms it; no row means confirmed', async () => {
    const lineConfirmed = async (invoiceId: string) => {
      const rows = (
        await run(owner, (tx) =>
          tx.query<{ x: { id: string; confirmed: boolean }[] }>(
            "select finance.source_sales('2026-01-01','2026-12-31') x",
          ),
        )
      ).rows[0]!.x;
      const line = (
        await migrator.query<{ id: string }>('select id from invoice_line where invoice_id=$1', [invoiceId])
      ).rows[0]!.id;
      return rows.find((r) => r.id === line)?.confirmed;
    };
    // A fresh order of plant A (with two active plants the plant must be named), on the shared client, truck and recette.
    const inA = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
      withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker, plantId: A.id }, fn);
    const master = await orderMaster(app, owner.id, marker);
    const order = await inA((tx) => insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }));
    const own = { ...scene, orderId: order.id };
    const d = await inA((tx) => insertDelivery(tx, owner.id, own, 1000));
    const inv = await inA((tx) => insertInvoice(tx, owner.id, own, d, 'Finance client r3 ' + marker, 1000));
    expect(await lineConfirmed(inv.id)).toBe(true); // never provisional: no status row
    await markProvisional(own.orderId);
    expect(await lineConfirmed(inv.id)).toBe(false); // provisional and unconfirmed
    await run(owner, (tx) => tx.query('select public.confirm_order_price($1, null)', [own.orderId]));
    expect(await lineConfirmed(inv.id)).toBe(true); // confirmed by the owner
  });
});
