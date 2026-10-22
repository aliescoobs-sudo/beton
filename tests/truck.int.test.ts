import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  createTruck,
  listTruckStatusLog,
  listTrucks,
  logTruckStatus,
  unavailableDates,
  updateTruck,
} from '../src/modules/master-data';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant', SessionUser>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);
// T900-T999: the pilot seed uses T1-T4 and the matrix test T100-T998; a random pick avoids reruns clashing.
const code = () => `T${900 + Math.floor(Math.random() * 100)}`;
const plate = () => `T${Math.random().toString(36).slice(2, 9).toUpperCase()}`;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
});

async function newTruck(role: 'owner' | 'partner' = 'owner') {
  for (let attempt = 0; attempt < 20; attempt++) {
    const created = await createTruck(app, users[role], { code: code(), plate: plate() });
    if (created.ok) return created.value;
    if (created.error !== 'DUPLICATE') throw new Error(created.error);
  }
  throw new Error('no free truck code');
}

describe('trucks (master-data T13)', () => {
  it.each(['owner', 'partner'] as const)(
    '%s creates (capacity defaults to 8000 L), edits, archives; audited',
    async (role) => {
      const truck = await newTruck(role);
      expect(truck.capacityL).toBe(8000);
      const updated = await updateTruck(
        app,
        users[role],
        truck.id,
        { plate: ` ${truck.plate.toLowerCase()} x `, capacityL: 9000 },
        'archived',
      );
      expect(updated).toMatchObject({
        ok: true,
        value: { plate: `${truck.plate} X`, capacityL: 9000, status: 'archived' },
      });
      const { rows } = await inCtx(users.owner, (tx) =>
        tx.query(`select action from audit_event where table_name = 'truck' and row_id = $1 order by id`, [
          truck.id,
        ]),
      );
      expect(rows.map((r) => r.action)).toEqual(['insert', 'update']);
    },
  );

  it.each(['owner', 'partner', 'office', 'plant'] as const)('%s reads the trucks', async (role) => {
    const truck = await newTruck();
    expect((await listTrucks(app, users[role])).map((t) => t.id)).toContain(truck.id);
  });

  it.each(['office', 'plant'] as const)(
    '%s cannot create or edit a truck (service and RLS)',
    async (role) => {
      const truck = await newTruck();
      await expect(createTruck(app, users[role], { code: code(), plate: plate() })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(
        updateTruck(app, users[role], truck.id, { plate: 'ZZZ 1', capacityL: 8000 }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        inCtx(users[role], (tx) =>
          tx.query(`insert into truck (id, code, plate) values (gen_random_uuid(), 'T998', 'RLS 1')`),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      const { rowCount } = await inCtx(users[role], (tx) =>
        tx.query(`update truck set plate = 'RLS 2', capacity_l = 1000 where id = $1`, [truck.id]),
      );
      expect(rowCount).toBe(0);
    },
  );

  it('only plate, capacity and status are updatable columns; the code is immutable; no DELETE', async () => {
    const truck = await newTruck();
    await expect(
      inCtx(users.owner, (tx) => tx.query(`update truck set code = 'T997' where id = $1`, [truck.id])),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(inCtx(users.owner, (tx) => tx.query('delete from truck'))).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('refuses a duplicate code or plate, and bad values', async () => {
    const truck = await newTruck();
    expect(await createTruck(app, users.owner, { code: truck.code.toLowerCase(), plate: plate() })).toEqual({
      ok: false,
      error: 'DUPLICATE',
    });
    expect(
      await createTruck(app, users.owner, { code: 'T996', plate: ` ${truck.plate.toLowerCase()}` }),
    ).toEqual({
      ok: false,
      error: 'DUPLICATE',
    });
    for (const bad of [
      { code: 'X1', plate: 'AB 1' },
      { code: 'T', plate: 'AB 1' },
      { code: 'T1000', plate: 'AB 1' },
      { code: 'T995', plate: '' },
      { code: 'T995', plate: 'AB 1', capacityL: 999 },
      { code: 'T995', plate: 'AB 1', capacityL: 30001 },
      { code: 'T995', plate: 'AB 1', capacityL: 8000.5 },
    ]) {
      expect(await createTruck(app, users.owner, bad)).toEqual({ ok: false, error: 'INVALID' });
    }
  });
});

describe('truck status log (master-data T13)', () => {
  const entry = (truckId: string, extra: object = {}) => ({
    truckId,
    status: 'breakdown',
    fromDate: '2026-11-04',
    toDate: '2026-11-06',
    reason: 'Boîte de vitesses',
    ...extra,
  });

  it('the plant logs a breakdown; everyone reads it; audited with the plant as actor', async () => {
    const truck = await newTruck();
    const logged = await logTruckStatus(app, users.plant, entry(truck.id));
    expect(logged).toMatchObject({
      ok: true,
      value: {
        status: 'breakdown',
        fromDate: '2026-11-04',
        toDate: '2026-11-06',
        reason: 'Boîte de vitesses',
      },
    });
    for (const role of ['owner', 'partner', 'office', 'plant'] as const) {
      expect((await listTruckStatusLog(app, users[role], truck.id)).map((e) => e.status)).toEqual([
        'breakdown',
      ]);
    }
    const { rows } = await inCtx(users.owner, (tx) =>
      tx.query(
        `select actor_user_id from audit_event where table_name = 'truck_status_log' and action = 'insert' order by id desc limit 1`,
      ),
    );
    expect(rows[0]?.actor_user_id).toBe(users.plant.id);
  });

  it('an open-ended entry and a correcting `available` entry are both accepted, in order', async () => {
    const truck = await newTruck();
    await logTruckStatus(app, users.plant, entry(truck.id, { toDate: null }));
    await logTruckStatus(
      app,
      users.plant,
      entry(truck.id, { status: 'available', fromDate: '2026-11-05', toDate: null, reason: 'Réparé' }),
    );
    expect((await listTruckStatusLog(app, users.owner, truck.id)).map((e) => e.status)).toEqual([
      'breakdown',
      'available',
    ]);
  });

  it.each(['owner', 'partner'] as const)('%s can log a status too (trucks.status.write)', async (role) => {
    const truck = await newTruck();
    expect(await logTruckStatus(app, users[role], entry(truck.id, { status: 'roadblock' }))).toMatchObject({
      ok: true,
      value: { status: 'roadblock' },
    });
  });

  it.each(['office'] as const)('%s cannot log a status (service and RLS)', async (role) => {
    const truck = await newTruck();
    await expect(logTruckStatus(app, users[role], entry(truck.id))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inCtx(users[role], (tx) =>
        tx.query(
          `insert into truck_status_log (id, truck_id, status, from_date, reason, logged_by)
           values (gen_random_uuid(), $1, 'breakdown', '2026-11-04', 'x', $2)`,
          [truck.id, users[role].id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the plant cannot log in someone else’s name, nor edit a truck, nor touch the log afterwards', async () => {
    const truck = await newTruck();
    await expect(
      inCtx(users.plant, (tx) =>
        tx.query(
          `insert into truck_status_log (id, truck_id, status, from_date, reason, logged_by)
           values (gen_random_uuid(), $1, 'breakdown', '2026-11-04', 'x', $2)`,
          [truck.id, users.owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      updateTruck(app, users.plant, truck.id, { plate: 'PLANT 1', capacityL: 1000 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inCtx(users.plant, (tx) => tx.query(`update truck set capacity_l = 1000 where id = $1`, [truck.id])),
    ).resolves.toMatchObject({ rowCount: 0 });
    await logTruckStatus(app, users.plant, entry(truck.id));
    for (const sql of [
      'update truck_status_log set reason = $1',
      'delete from truck_status_log',
      'truncate truck_status_log',
    ]) {
      await expect(
        inCtx(users.plant, (tx) => tx.query(sql, sql.startsWith('update') ? ['x'] : [])),
      ).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('refuses bad input: unknown truck, end not after start, impossible date, missing reason, unknown status', async () => {
    const truck = await newTruck();
    expect(await logTruckStatus(app, users.plant, entry('00000000-0000-7000-8000-000000000000'))).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await logTruckStatus(app, users.plant, entry('not-a-uuid'))).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    for (const bad of [
      { toDate: '2026-11-04' },
      { toDate: '2026-11-03' },
      { fromDate: '2026-02-30' },
      { reason: '  ' },
      { status: 'asleep' },
    ]) {
      expect(await logTruckStatus(app, users.plant, entry(truck.id, bad))).toEqual({
        ok: false,
        error: 'INVALID',
      });
    }
  });
});

describe('truck availability (master-data T14, AC-MD-08)', () => {
  it('a breakdown for [D4, D6) makes D4 and D5 unavailable and D6 available, through the service', async () => {
    const truck = await newTruck();
    await logTruckStatus(app, users.plant, {
      truckId: truck.id,
      status: 'breakdown',
      fromDate: '2026-11-04',
      toDate: '2026-11-06',
      reason: 'Panne',
    });
    for (const role of ['owner', 'partner', 'office', 'plant'] as const) {
      expect(
        await unavailableDates(app, users[role], truck.id, { from: '2026-11-03', to: '2026-11-08' }),
      ).toEqual({
        ok: true,
        value: ['2026-11-04', '2026-11-05'],
      });
    }
  });

  it('a correcting entry and archiving are taken into account', async () => {
    const truck = await newTruck();
    const base = { truckId: truck.id, toDate: null, reason: 'x' };
    await logTruckStatus(app, users.plant, { ...base, status: 'roadblock', fromDate: '2026-11-04' });
    await logTruckStatus(app, users.plant, { ...base, status: 'available', fromDate: '2026-11-06' });
    expect(
      await unavailableDates(app, users.office, truck.id, { from: '2026-11-04', to: '2026-11-08' }),
    ).toEqual({
      ok: true,
      value: ['2026-11-04', '2026-11-05'],
    });
    await updateTruck(app, users.owner, truck.id, { plate: truck.plate, capacityL: 8000 }, 'archived');
    expect(
      await unavailableDates(app, users.office, truck.id, { from: '2026-11-04', to: '2026-11-06' }),
    ).toEqual({
      ok: true,
      value: ['2026-11-04', '2026-11-05'],
    });
  });

  it('refuses an empty, reversed, impossible or over-long range, and an unknown truck', async () => {
    const truck = await newTruck();
    for (const range of [
      { from: '2026-11-04', to: '2026-11-04' },
      { from: '2026-11-05', to: '2026-11-04' },
      { from: '2026-02-30', to: '2026-03-04' },
      { from: '2026-01-01', to: '2027-02-01' },
    ]) {
      expect(await unavailableDates(app, users.owner, truck.id, range)).toEqual({
        ok: false,
        error: 'INVALID',
      });
    }
    const range = { from: '2026-11-04', to: '2026-11-05' };
    expect(await unavailableDates(app, users.owner, '00000000-0000-7000-8000-000000000000', range)).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await unavailableDates(app, users.owner, 'nope', range)).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
  });
});
