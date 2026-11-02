import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decideDisclosure,
  listMyDisclosures,
  listPendingDisclosures,
  requestDisclosure,
  viewDisclosure,
} from '../src/modules/ledger';
import { withRlsContext } from '../src/lib/db/rls-context';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { v1Actors } from './helpers/v1-actors';
import { clientWithLoads, deliveryScene, orderMaster } from './helpers/ledger-fixtures';

// §16.3: figure disclosure is scoped to a person, a data item and a duration (default one view within 15 minutes); every view is audited.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
let done: () => Promise<void>;
afterAll(async () => {
  await done();
  await Promise.all([app.end(), migrator.end()]);
});
const marker = `dc${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let owner: SessionUser;
let admin: SessionUser;
let sales: SessionUser;
let purchases: SessionUser;
let plant: SessionUser;
let code = '';
let totalTtc = 0;

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  owner = v.owner;
  admin = v.session('app_admin');
  sales = v.session('office_sales');
  purchases = v.session('office_purchases');
  plant = v.session('plant_manager');
  const scene = await deliveryScene(app, owner.id, marker);
  const master = await orderMaster(app, owner.id, marker);
  const c = await clientWithLoads(app, owner.id, master, scene, [[4000]], { delivered: true });
  code = c.orders[0]!.code;
  totalTtc = Number(
    (
      await migrator.query<{ t: string }>(
        'select total_ttc_centimes::text as t from sales_order where code = $1',
        [code],
      )
    ).rows[0]!.t,
  );
});

const audited = async (ref: string) =>
  Number(
    (
      await migrator.query<{ n: string }>(
        `select count(*)::text as n from audit_event where action = 'view' and table_name = $1`,
        [`disclosure:order_total:${ref}`],
      )
    ).rows[0]!.n,
  );

describe('request and decision (§16.3)', () => {
  let id = '';
  it('an unknown item is refused; a known one waits; the same ask twice is refused', async () => {
    expect(await requestDisclosure(app, sales, { kind: 'order_total', ref: 'CMD-0000-00000' })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    const r = await requestDisclosure(app, sales, {
      kind: 'order_total',
      ref: code,
      documentKind: 'order',
      documentRef: code,
      reason: 'client on the phone',
    });
    if (!r.ok) throw new Error(r.error);
    id = r.value.id;
    expect(await requestDisclosure(app, sales, { kind: 'order_total', ref: code })).toEqual({
      ok: false,
      error: 'ALREADY_WAITING',
    });
  });
  it('nothing is shown before the decision, and the request holds no figure', async () => {
    expect(await viewDisclosure(app, sales, id)).toEqual({ ok: false, error: 'NOT_AVAILABLE' });
    const mine = await listMyDisclosures(app, sales);
    expect(JSON.stringify(mine)).not.toContain(String(totalTtc));
    const row = (await migrator.query('select * from disclosure_request where id = $1', [id])).rows[0];
    expect(JSON.stringify(row)).not.toContain(String(totalTtc));
  });
  it('only owner and app_admin see and decide the cards; the offices and the plant cannot', async () => {
    const cards = await listPendingDisclosures(app, owner);
    expect(cards.find((c) => c.id === id)).toMatchObject({ itemKind: 'order_total', itemRef: code });
    await expect(listPendingDisclosures(app, sales)).rejects.toThrow(/Forbidden/);
    await expect(decideDisclosure(app, sales, { id, approve: true })).rejects.toThrow(/Forbidden/);
    await expect(decideDisclosure(app, plant, { id, approve: true })).rejects.toThrow(/Forbidden/);
    await expect(requestDisclosure(app, owner, { kind: 'order_total', ref: code })).rejects.toThrow(
      /Forbidden/,
    );
  });
  it('the default scope is one view within 15 minutes, for that person only', async () => {
    expect(await decideDisclosure(app, admin, { id, approve: true })).toEqual({ ok: true, value: true });
    const row = (
      await migrator.query<{ views_allowed: number; mins: number; mode: string }>(
        `select views_allowed, mode, round(extract(epoch from expires_at - decided_at) / 60)::int as mins from disclosure_request where id = $1`,
        [id],
      )
    ).rows[0]!;
    expect(row).toMatchObject({ views_allowed: 1, mode: 'single_view', mins: 15 });
    // someone else cannot use it
    expect(await viewDisclosure(app, purchases, id)).toEqual({ ok: false, error: 'NOT_AVAILABLE' });
    expect(await viewDisclosure(app, plant, id)).toEqual({ ok: false, error: 'NOT_AVAILABLE' });
    const before = await audited(code);
    const seen = await viewDisclosure(app, sales, id);
    expect(seen).toMatchObject({ ok: true, value: { centimes: totalTtc, viewsLeft: 0 } });
    expect(await audited(code)).toBe(before + 1);
    expect(await viewDisclosure(app, sales, id)).toEqual({ ok: false, error: 'NOT_AVAILABLE' });
    expect(await audited(code)).toBe(before + 1);
  });
});

describe('window, expiry and denial (§16.3)', () => {
  it('a window allows several views until it expires; every view is audited', async () => {
    const r = await requestDisclosure(app, purchases, { kind: 'order_total', ref: code });
    if (!r.ok) throw new Error(r.error);
    await decideDisclosure(app, owner, { id: r.value.id, approve: true, mode: 'window', minutes: 30 });
    const before = await audited(code);
    for (let i = 0; i < 3; i++) {
      const v = await viewDisclosure(app, purchases, r.value.id);
      expect(v).toMatchObject({ ok: true, value: { centimes: totalTtc, viewsLeft: null } });
    }
    expect(await audited(code)).toBe(before + 3);
    await withRlsContext(migrator, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
      tx.query(`update disclosure_request set expires_at = now() - interval '1 second' where id = $1`, [
        r.value.id,
      ]),
    );
    expect(await viewDisclosure(app, purchases, r.value.id)).toEqual({ ok: false, error: 'NOT_AVAILABLE' });
  });
  it('a denial shows nothing; a request cannot be decided twice; the scope is bounded', async () => {
    const r = await requestDisclosure(app, plant, { kind: 'order_total', ref: code });
    if (!r.ok) throw new Error(r.error);
    expect(await decideDisclosure(app, owner, { id: r.value.id, approve: true, minutes: 61 })).toEqual({
      ok: false,
      error: 'INVALID',
    });
    await decideDisclosure(app, owner, { id: r.value.id, approve: false });
    expect(await viewDisclosure(app, plant, r.value.id)).toEqual({ ok: false, error: 'NOT_AVAILABLE' });
    expect(await decideDisclosure(app, owner, { id: r.value.id, approve: true })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
  });
});
