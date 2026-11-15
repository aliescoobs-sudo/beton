import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  addChargeDocument,
  chargesToCsv,
  decideCharge,
  listCharges,
  markChargePaid,
  recordCharge,
} from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import type { Role } from '../src/modules/platform-security/domain/permissions';
import { testEnv } from './db-env';
import { v1Actors } from './helpers/v1-actors';

// T19 item 6 (D245, D247, migration 0244): the charges register and its control by amount.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const marker = `ch_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let ids = {} as Record<Role, string>;
let done: () => Promise<void>;
const user = (role: Role) => ({ id: ids[role], role }) as unknown as SessionUser;
beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  ids = v.ids;
  done = v.done;
});
afterAll(async () => {
  await done();
  await app.end();
});

const base = (name: string, ht: string, vat = '0', documentRef?: string) => ({
  date: '2026-12-01',
  beneficiary: `${name} ${marker}`,
  category: 'maintenance',
  ht,
  vat,
  mode: 'cash',
  ...(documentRef ? { documentRef } : {}),
});
const find = async (as: Role, name: string) =>
  (await listCharges(app, user(as))).find((c) => c.beneficiary === `${name} ${marker}`);
const mk = async (name: string, ht: string, vat = '0', doc?: string) => {
  const r = await recordCharge(app, user('office_purchases'), base(name, ht, vat, doc));
  expect(r.ok).toBe(true);
  return (r as { ok: true; value: { id: string } }).value.id;
};

describe('the control by amount (D247, default limits 1 000 and 5 000 MAD)', () => {
  it('a small charge is recorded and payable at once; TTC is HT + VAT', async () => {
    const id = await mk('petit', '400', '80', 'REC-1');
    const c = await find('office_purchases', 'petit');
    expect(c).toMatchObject({
      status: 'recorded',
      level: 'small',
      htCentimes: 40_000,
      vatCentimes: 8_000,
      ttcCentimes: 48_000,
      noDocument: false,
    });
    expect((await markChargePaid(app, user('office_purchases'), { id })).ok).toBe(true);
    expect((await find('office_purchases', 'petit'))?.status).toBe('paid');
    expect((await markChargePaid(app, user('office_purchases'), { id })).ok).toBe(false); // twice
  });

  it('the middle band waits for ANOTHER user: not payable before, nobody validates their own preparation, the Responsable validates', async () => {
    const id = await mk('moyen', '2000', '400', 'F-2');
    expect(await find('office_purchases', 'moyen')).toMatchObject({
      status: 'pending_validation',
      level: 'validate',
    });
    expect((await markChargePaid(app, user('office_purchases'), { id })).ok).toBe(false);
    // the Assistante has no right to decide at all
    await expect(decideCharge(app, user('office_purchases'), { id, decision: 'validate' })).rejects.toThrow();
    // an owner who prepared a charge cannot validate it either
    const own = (await recordCharge(app, user('owner'), base('moyen-owner', '2000', '0', 'F-3'))) as {
      ok: true;
      value: { id: string };
    };
    expect((await decideCharge(app, user('owner'), { id: own.value.id, decision: 'validate' })).ok).toBe(
      false,
    );
    expect((await decideCharge(app, user('owner'), { id: own.value.id, decision: 'approve' })).ok).toBe(
      false,
    );
    // the Responsable validates it, then it can be paid
    expect((await decideCharge(app, user('office_sales'), { id, decision: 'validate' })).ok).toBe(true);
    expect(await find('office_purchases', 'moyen')).toMatchObject({ status: 'validated' });
    expect((await markChargePaid(app, user('office_purchases'), { id })).ok).toBe(true);
    // the owner may validate a charge prepared by somebody else at any amount
    expect(
      (
        await decideCharge(app, user('owner'), {
          id: await mk('moyen2', '2500', '0', 'F-4'),
          decision: 'validate',
        })
      ).ok,
    ).toBe(true);
  });

  it('above the upper limit only the owner or app_admin approves; the Responsable cannot', async () => {
    const id = await mk('gros', '6000', '1200', 'F-5');
    expect(await find('office_purchases', 'gros')).toMatchObject({
      status: 'pending_approval',
      level: 'owner',
    });
    expect((await decideCharge(app, user('office_sales'), { id, decision: 'validate' })).ok).toBe(false);
    expect((await decideCharge(app, user('office_sales'), { id, decision: 'approve' })).ok).toBe(false);
    expect((await markChargePaid(app, user('office_purchases'), { id })).ok).toBe(false);
    expect((await decideCharge(app, user('app_admin'), { id, decision: 'approve' })).ok).toBe(true);
    expect((await markChargePaid(app, user('office_purchases'), { id })).ok).toBe(true);
    // a rejected charge is closed
    const r = await mk('gros-rejet', '7000', '0', 'F-6');
    expect(
      (await decideCharge(app, user('owner'), { id: r, decision: 'reject', note: 'pas prévu' })).ok,
    ).toBe(true);
    expect((await markChargePaid(app, user('office_purchases'), { id: r })).ok).toBe(false);
  });
});

describe('the supporting document and who sees what', () => {
  it('a charge with no document is flagged, also once paid; adding the reference lifts the flag; nothing is silently accepted', async () => {
    const id = await mk('sans-justif', '300');
    expect((await find('office_purchases', 'sans-justif'))?.noDocument).toBe(true);
    expect(await markChargePaid(app, user('office_purchases'), { id })).toMatchObject({
      ok: true,
      value: { withDocument: false },
    });
    expect(await find('office_purchases', 'sans-justif')).toMatchObject({ status: 'paid', noDocument: true });
    expect((await addChargeDocument(app, user('office_purchases'), { id, ref: 'REC-9' })).ok).toBe(true);
    expect(await find('office_purchases', 'sans-justif')).toMatchObject({
      status: 'paid',
      noDocument: false,
      documentRef: 'REC-9',
    });
  });

  it('the Responsable sees only what waits for its validation; roles without the permission are refused; the tables are closed', async () => {
    await mk('attend', '1500', '0', 'F-7');
    const seen = await listCharges(app, user('office_sales'));
    expect(seen.length).toBeGreaterThan(0);
    for (const c of seen) expect(c.status).toBe('pending_validation');
    await expect(recordCharge(app, user('office_sales'), base('x', '10'))).rejects.toThrow();
    for (const r of ['plant_manager', 'accountant', 'driver'] as const)
      await expect(listCharges(app, user(r))).rejects.toThrow();
    for (const r of ['office_purchases', 'owner'] as const) {
      await expect(
        withRlsContext(app, { userId: ids[r], role: r as never, requestId: marker }, (tx) =>
          tx.query('select * from charge'),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        withRlsContext(app, { userId: ids[r], role: r as never, requestId: marker }, (tx) =>
          tx.query(`update charge set note = 'x'`),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('refuses a bad amount, a bad category and an empty TTC', async () => {
    expect((await recordCharge(app, user('office_purchases'), { ...base('bad', 'abc') })).ok).toBe(false);
    expect((await recordCharge(app, user('office_purchases'), { ...base('bad', '0', '0') })).ok).toBe(false);
    expect(
      (await recordCharge(app, user('office_purchases'), { ...base('bad', '10'), category: 'jewellery' })).ok,
    ).toBe(false);
  });

  it('the CSV neutralises a formula in a text cell', () => {
    const csv = chargesToCsv([
      {
        id: 'x',
        date: '2026-12-01',
        beneficiary: '=HYPERLINK("x")',
        category: 'other',
        htCentimes: 100,
        vatCentimes: 0,
        ttcCentimes: 100,
        mode: 'cash',
        status: 'recorded',
        level: 'small',
        documentRef: null,
        noDocument: true,
        preparedBy: null,
        decidedBy: null,
        note: null,
      },
    ]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv.split('\n')[1]).toContain('1,00');
  });
});
