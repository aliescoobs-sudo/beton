import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEnv } from './db-env';
import { setReservedBoundary } from './setup-db';
import { v1Actors } from './helpers/v1-actors';
import { clientWithLoads, deliveryScene, orderMaster } from './helpers/ledger-fixtures';

/**
 * R19-01: the self-service (requester-only) definers validate an existing, active, admitted actor BEFORE any lookup.
 * REAL rows: an approved disclosure request, approved document requests (a statement and a delivery-note copy of a real delivery), a real notification
 * and a real push subscription of a real office_sales account. The attacker presents that account's user id with an unset, an empty, a wrong, a
 * reserved and a no-longer-admitted role, with the PRODUCTION configuration (the reserved-role boundary ON, as on every server).
 * Every refusal is asserted exactly (SQLSTATE and message); each call COMMITS if it is wrongly accepted, so unchanged state is a real observation.
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `r1${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let done: () => Promise<void>;
let ownerId = '';
let salesId = '';
let discId = '';
let discRef = '';
let releveId = '';
let blCopyId = '';
let blNo = '';
let clientCode = '';
let notificationId = '';
let endpoint = '';

async function call(
  role: string | null,
  user: string,
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult> {
  const c = await app.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.role', $1, true), set_config('app.user_id', $2, true)`, [
      role ?? '',
      user,
    ]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const NOT_ADMITTED = (door: string) => ({ code: '42501', message: `${door}: not an admitted actor` });
const WRONG_ROLE = (role: string) => ({
  code: '42501',
  message: expect.stringContaining(`ctx: request role ${role} does not match`) as unknown as string,
});

async function snapshot() {
  const q = async (sql: string, p: unknown[] = []) => (await migrator.query(sql, p)).rows;
  return {
    disclosure: await q(
      `select id, status, views_used, views_allowed from disclosure_request where requester = $1 order by id`,
      [salesId],
    ),
    views: await q(`select count(*)::int as n from audit_event where action = 'view' and row_id = $1`, [
      discId,
    ]),
    docs: await q(`select id, status, used_at from document_request where requester = $1 order by id`, [
      salesId,
    ]),
    notes: await q(`select id, read_at from notification where recipient = $1 order by id`, [salesId]),
    push: await q(`select endpoint, user_id from push_subscription where endpoint = $1`, [endpoint]),
    locale: await q(`select locale from "user" where id = $1`, [salesId]),
  };
}

beforeAll(async () => {
  await setReservedBoundary(env.DATABASE_URL_MIGRATOR, true);
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  ownerId = v.owner.id;
  salesId = v.ids.office_sales;
  // a real delivered order: a real delivery note (its BL number and its client code)
  const scene = await deliveryScene(app, ownerId, marker);
  const master = await orderMaster(app, ownerId, marker);
  const c = await clientWithLoads(app, ownerId, master, scene, [[4000]], { delivered: true });
  discRef = c.orders[0]!.code;
  const bl = await migrator.query<{ bl_no: string; code: string }>(
    `select d.bl_no, c.code from delivery d join sales_order o on o.id = d.order_id join client c on c.id = o.client_id where o.code = $1 limit 1`,
    [discRef],
  );
  blNo = bl.rows[0]!.bl_no;
  clientCode = bl.rows[0]!.code;

  // the approved disclosure request (single view)
  discId = (
    await call(
      'office_sales',
      salesId,
      `select public.request_disclosure($1, $2, 'order', $2, 'phone') as id`,
      ['order_total', discRef],
    )
  ).rows[0].id;
  await call('owner', ownerId, `select public.decide_disclosure($1, true, 'single_view', 15)`, [discId]);
  // two approved document requests: a statement and the copy of the delivery note
  releveId = (
    await call(
      'office_sales',
      salesId,
      `select public.request_document('releve', 'client', $1, null, null) as id`,
      [clientCode],
    )
  ).rows[0].id;
  blCopyId = (
    await call(
      'office_sales',
      salesId,
      `select public.request_document('bl_copy', 'client', $1, $2, null) as id`,
      [clientCode, blNo],
    )
  ).rows[0].id;
  for (const id of [releveId, blCopyId])
    await call('owner', ownerId, `select public.decide_document_request($1, true)`, [id]);
  // a real, unread notification and a real push subscription
  await call('office_sales', salesId, `select public.send_test_notification()`);
  notificationId = (
    await migrator.query<{ id: string }>(
      `select id from notification where recipient = $1 and read_at is null`,
      [salesId],
    )
  ).rows[0]!.id;
  endpoint = `https://fcm.googleapis.com/fcm/send/${marker}`;
  await call('office_sales', salesId, `select public.save_push_subscription($1, 'k', 'a')`, [endpoint]);
});
afterAll(async () => {
  await done?.();
  await setReservedBoundary(env.DATABASE_URL_MIGRATOR, false);
  await Promise.all([app.end(), migrator.end()]);
});

/** The self-service doors, each with real arguments. */
const doors = (): { door: string; sql: string; params: unknown[] }[] => [
  { door: 'view_disclosure', sql: `select * from public.view_disclosure($1)`, params: [discId] },
  { door: 'my_disclosures', sql: `select * from public.my_disclosures()`, params: [] },
  {
    door: 'consume_document_copy',
    sql: `select public.consume_document_copy($1, 'bl_copy', $2)`,
    params: [blCopyId, blNo],
  },
  { door: 'use_document_request', sql: `select * from public.use_document_request($1)`, params: [releveId] },
  { door: 'my_document_requests', sql: `select * from public.my_document_requests()`, params: [] },
  { door: 'my_notifications', sql: `select * from public.my_notifications(50)`, params: [] },
  {
    door: 'mark_notifications_read',
    sql: `select public.mark_notifications_read($1::uuid[])`,
    params: [[notificationId]],
  },
  { door: 'unread_notification_count', sql: `select public.unread_notification_count()`, params: [] },
  { door: 'send_test_notification', sql: `select public.send_test_notification()`, params: [] },
  { door: 'set_my_locale', sql: `select public.set_my_locale('ar')`, params: [] },
  {
    door: 'save_push_subscription',
    sql: `select public.save_push_subscription($1, 'evil', 'evil')`,
    params: [endpoint],
  },
  { door: 'drop_push_subscription', sql: `select public.drop_push_subscription($1)`, params: [endpoint] },
  { door: 'my_surveys', sql: `select * from public.my_surveys()`, params: [] },
];

describe('R19-01: a requester id without a valid actor is refused before any lookup', () => {
  it('unset and empty role: the exact not-admitted refusal, no view consumed, no state changed', async () => {
    const before = await snapshot();
    expect(before.disclosure[0]).toMatchObject({ status: 'approved', views_used: 0 });
    for (const role of [null, '']) {
      for (const d of doors()) {
        await expect(
          call(role, salesId, d.sql, d.params),
          `${d.door} with role ${JSON.stringify(role)}`,
        ).rejects.toMatchObject(NOT_ADMITTED(d.door));
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it('a wrong role (the account is office_sales; the request says another or an unknown role): refused by the actor boundary, state unchanged', async () => {
    const before = await snapshot();
    for (const role of ['owner', 'plant_manager', 'bogus']) {
      for (const d of doors()) {
        await expect(call(role, salesId, d.sql, d.params), `${d.door} as ${role}`).rejects.toMatchObject(
          WRONG_ROLE(role),
        );
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it('a RESERVED role (production boundary ON): an account that is now partner or support is refused by every door', async () => {
    const before = await snapshot();
    for (const role of ['partner', 'support']) {
      await migrator.query(`update "user" set role = $2 where id = $1`, [salesId, role]);
      try {
        for (const d of doors()) {
          await expect(call(role, salesId, d.sql, d.params), `${d.door} as ${role}`).rejects.toMatchObject(
            WRONG_ROLE(role),
          );
        }
      } finally {
        await migrator.query(`update "user" set role = 'office_sales' where id = $1`, [salesId]);
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it('an account that is no longer in the audience (now a driver) cannot redeem the approved figure or document; nothing is consumed', async () => {
    const before = await snapshot();
    await migrator.query(`update "user" set role = 'driver' where id = $1`, [salesId]);
    try {
      await expect(
        call('driver', salesId, `select * from public.view_disclosure($1)`, [discId]),
      ).rejects.toMatchObject({ code: '42501', message: 'view_disclosure: not available' });
      await expect(
        call('driver', salesId, `select public.consume_document_copy($1, 'bl_copy', $2)`, [blCopyId, blNo]),
      ).rejects.toMatchObject({ code: '42501', message: 'consume_document_copy: not available' });
      await expect(
        call('driver', salesId, `select * from public.use_document_request($1)`, [releveId]),
      ).rejects.toMatchObject({ code: '42501', message: 'use_document_request: not available' });
    } finally {
      await migrator.query(`update "user" set role = 'office_sales' where id = $1`, [salesId]);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('a disabled account is refused as well (the boundary needs an ACTIVE account)', async () => {
    const before = await snapshot();
    await migrator.query(`update "user" set status = 'disabled' where id = $1`, [salesId]);
    try {
      for (const d of doors())
        await expect(call('office_sales', salesId, d.sql, d.params), d.door).rejects.toMatchObject({
          code: '42501',
        });
    } finally {
      await migrator.query(`update "user" set status = 'active' where id = $1`, [salesId]);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('another admitted account (correct role) gets nothing of the requester', async () => {
    const other = (
      await migrator.query<{ id: string }>(
        `select id from "user" where role = 'office_purchases' and name like $1`,
        [`${marker}%`],
      )
    ).rows[0]!.id;
    await expect(
      call('office_purchases', other, `select * from public.view_disclosure($1)`, [discId]),
    ).rejects.toMatchObject({ message: 'view_disclosure: not available' });
    expect((await call('office_purchases', other, `select * from public.my_disclosures()`)).rowCount).toBe(0);
    expect(
      (await call('office_purchases', other, `select * from public.my_notifications(50)`)).rowCount,
    ).toBe(0);
  });

  it('positive controls: the authorized requester reads her own lists and redeems the figure ONCE', async () => {
    expect((await call('office_sales', salesId, `select * from public.my_disclosures()`)).rowCount).toBe(1);
    expect(
      (await call('office_sales', salesId, `select * from public.my_document_requests()`)).rowCount,
    ).toBe(2);
    expect((await call('office_sales', salesId, `select * from public.my_notifications(50)`)).rowCount).toBe(
      1,
    );
    expect(
      (await call('office_sales', salesId, `select public.unread_notification_count() as n`)).rows[0].n,
    ).toBe(1);
    const view = await call('office_sales', salesId, `select * from public.view_disclosure($1)`, [discId]);
    expect(view.rows[0]).toMatchObject({ item_kind: 'order_total', item_ref: discRef, views_left: 0 });
    expect(Number(view.rows[0].centimes)).toBeGreaterThan(0);
    await expect(
      call('office_sales', salesId, `select * from public.view_disclosure($1)`, [discId]),
    ).rejects.toMatchObject({ message: 'view_disclosure: not available' });
    expect(
      (
        await call('office_sales', salesId, `select public.consume_document_copy($1, 'bl_copy', $2) as ok`, [
          blCopyId,
          blNo,
        ])
      ).rows[0].ok,
    ).toBe(true);
    expect(
      (await call('office_sales', salesId, `select * from public.use_document_request($1)`, [releveId]))
        .rows[0],
    ).toMatchObject({ kind: 'releve', party_code: clientCode });
    expect(
      (await call('office_sales', salesId, `select public.mark_notifications_read(null) as n`)).rows[0].n,
    ).toBe(1);
    await call('office_sales', salesId, `select public.set_my_locale('ar')`);
    expect((await migrator.query(`select locale from "user" where id = $1`, [salesId])).rows[0].locale).toBe(
      'ar',
    );
    expect(
      (await call('office_sales', salesId, `select public.drop_push_subscription($1) as ok`, [endpoint]))
        .rows[0].ok,
    ).toBe(true);
  });
});
