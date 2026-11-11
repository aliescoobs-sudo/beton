import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEnv } from './db-env';
import { plantWorld, type World } from './helpers/plant-world';

/**
 * R18-02: the four trip doors (attach_trip_load, confirm_trip_delivered, confirm_trip_stage, correct_trip_stage) with a request that names a
 * user but NO role. The targets are REAL: a rotation of plant B and a rotation with no plant, each taken to the state in which an authorized
 * actor WOULD succeed (positive controls first), so a refusal can only come from the actor check.
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 8 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `r2${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let w: World;

beforeAll(async () => {
  w = await plantWorld(app, migrator, marker);
});
afterAll(async () => {
  await w.done();
  await Promise.all([app.end(), migrator.end()]);
});

interface Target {
  label: string;
  trip: string;
  load: string;
}
/** A rotation taken to where each door can act: loaded declared (no load linked yet), a separate unlinked load for attach, a finished unloading. */
async function prepared(
  plant: string,
  truck: string,
  driverRow: string,
  driverUser: never,
  nullPlant = false,
) {
  const t = await w.newTrip(plant, truck, driverRow, { nullPlant });
  await w.tap(driverUser, t.trip, 'loaded');
  const load = await w.plantLoad(nullPlant ? w.plantA : plant, t.order, truck);
  if (nullPlant) await w.sup(`update delivery set plant_id = null where id = $1`, [load], ['delivery']); // a legacy load names no plant
  return { ...t, load };
}
async function stageDone(trip: string, driverUser: never, steps: string[], vol = 1000) {
  for (const s of steps) await w.tap(driverUser, trip, s, s === 'unloading_finished' ? vol : null);
}

const NO_ROLE_CONTEXTS = (user: string) => [
  { label: 'a real user id, role unset', ctx: { user, role: null } },
  { label: 'a real user id, role empty', ctx: { user, role: '' } },
];

describe('R18-02: a missing role is refused FIRST, before any lookup, with one answer', () => {
  it('attach_trip_load: a real trip of plant B and a real NULL-plant trip, with a real unlinked load, are not touched without a role', async () => {
    const targets: Target[] = [];
    for (const [label, plant, truck, row, user, nullPlant] of [
      ['B', w.plantB, w.truckB, w.driverB, w.driverUserB, false],
      ['N', w.plantA, w.truckN, w.driverA, w.driverUserA, true],
    ] as const) {
      const t = await prepared(plant, truck, row, user as never, nullPlant);
      targets.push({ label, trip: t.trip, load: t.load });
    }
    const answers = new Set<string>();
    for (const t of targets) {
      const events = () =>
        w.count(`select 1 from trip_event where trip_id = '${t.trip}' and delivery_id is not null`);
      const audit = () => w.count(`select 1 from audit_event`);
      const before = [await events(), await audit(), await w.count('select 1 from delivery_delivered')];
      for (const { label, ctx } of NO_ROLE_CONTEXTS(w.pmA.id)) {
        const err = await w.failure(ctx, 'select public.attach_trip_load($1, $2)', [t.trip, t.load]);
        expect(err, `${t.label} / ${label}`).not.toBeNull();
        expect(err!.code).toBe('42501');
        answers.add(err!.message);
      }
      // the wrong audience too: a real accountant, a real driver, the OTHER plant's manager
      for (const who of [w.accountant, w.driverUserA, w.pmA, w.pmB]) {
        if (t.label === 'N' || who !== w.pmB) {
          const err = await w.failure(
            { user: who.id, role: who.role },
            'select public.attach_trip_load($1, $2)',
            [t.trip, t.load],
          );
          if (t.label === 'B' && who === w.pmB) continue;
          expect(err?.code, `${t.label} / ${who.role}`).toBe('42501');
          answers.add(err!.message);
        }
      }
      expect([await events(), await audit(), await w.count('select 1 from delivery_delivered')]).toEqual(
        before,
      );
    }
    // a trip that does not exist gets the same answer as a real foreign one
    const missing = await w.failure(
      { user: w.pmA.id, role: null },
      'select public.attach_trip_load($1, $2)',
      [randomUUID(), randomUUID()],
    );
    answers.add(missing!.message);
    expect([...answers]).toEqual(['attach_trip_load: not your rotation']);
    // positive controls: the owner does link the load on the B rotation (so the refusals were about the actor); and the plant B manager on his
    const b = targets[0]!;
    await w.as(w.owner, (tx) => tx.query('select public.attach_trip_load($1, $2)', [b.trip, b.load]));
    expect(
      await w.count(`select 1 from trip_event where trip_id = '${b.trip}' and delivery_id = '${b.load}'`),
    ).toBe(1);
  });

  it('confirm_trip_delivered: an unloaded rotation with its load linked sets NO billing gate without a role (plant B and NULL plant)', async () => {
    const made: Target[] = [];
    for (const [label, plant, truck, row, user, nullPlant] of [
      ['B', w.plantB, w.truckB, w.driverB, w.driverUserB, false],
      ['N', w.plantA, w.truckN, w.driverA, w.driverUserA, true],
    ] as const) {
      const t = await prepared(plant, truck, row, user as never, nullPlant);
      await w.as(w.owner, (tx) => tx.query('select public.attach_trip_load($1, $2)', [t.trip, t.load]));
      await stageDone(t.trip, user as never, [
        'departed',
        'arrived',
        'unloading_started',
        'unloading_finished',
      ]);
      made.push({ label, trip: t.trip, load: t.load });
    }
    const answers = new Set<string>();
    for (const t of made) {
      const gates = () => w.count(`select 1 from delivery_delivered where delivery_id = '${t.load}'`);
      const audit = () => w.count(`select 1 from audit_event where table_name = 'delivery_delivered'`);
      const before = [await gates(), await audit()];
      for (const { label, ctx } of NO_ROLE_CONTEXTS(w.pmA.id)) {
        const err = await w.failure(ctx, 'select public.confirm_trip_delivered($1)', [t.trip]);
        expect(err?.code, `${t.label} / ${label}`).toBe('42501');
        answers.add(err!.message);
      }
      for (const who of [w.accountant, w.driverUserA, w.sales]) {
        const err = await w.failure(
          { user: who.id, role: who.role },
          'select public.confirm_trip_delivered($1)',
          [t.trip],
        );
        expect(err?.code, `${t.label} / ${who.role}`).toBe('42501');
        answers.add(err!.message);
      }
      expect([await gates(), await audit()]).toEqual(before);
    }
    expect(
      (await w.failure({ user: w.pmA.id, role: null }, 'select public.confirm_trip_delivered($1)', [
        randomUUID(),
      ]))!.message,
    ).toBe('confirm_trip_delivered: not your rotation');
    expect([...answers]).toEqual(['confirm_trip_delivered: not your rotation']);
    // positive control: the owner confirms the B rotation's delivery (the state was confirmable)
    const ok = await w.as(
      w.owner,
      async (tx) =>
        (await tx.query<{ c: boolean }>('select public.confirm_trip_delivered($1) as c', [made[0]!.trip]))
          .rows[0]!.c,
    );
    expect(ok).toBe(true);
    expect(await w.count(`select 1 from delivery_delivered where delivery_id = '${made[0]!.load}'`)).toBe(1);
  });

  it('confirm_trip_stage and correct_trip_stage: no confirmation row and no correction row without a role', async () => {
    const made: Target[] = [];
    for (const [label, plant, truck, row, user, nullPlant] of [
      ['B', w.plantB, w.truckB, w.driverB, w.driverUserB, false],
      ['N', w.plantA, w.truckN, w.driverA, w.driverUserA, true],
    ] as const) {
      const t = await prepared(plant, truck, row, user as never, nullPlant);
      await stageDone(t.trip, user as never, ['departed']);
      made.push({ label, trip: t.trip, load: t.load });
    }
    const answers = new Set<string>();
    for (const t of made) {
      const rows = () => w.count(`select 1 from trip_event_confirmation where trip_id = '${t.trip}'`);
      const corr = () => w.count(`select 1 from trip_event_correction where trip_id = '${t.trip}'`);
      const audit = () => w.count(`select 1 from audit_event`);
      const before = [await rows(), await corr(), await audit()];
      for (const { label, ctx } of NO_ROLE_CONTEXTS(w.pmA.id)) {
        const a = await w.failure(ctx, 'select public.confirm_trip_stage($1, $2, now())', [
          t.trip,
          'departed',
        ]);
        const b = await w.failure(ctx, `select public.correct_trip_stage($1, $2, now(), $3)`, [
          t.trip,
          'departed',
          'a real reason',
        ]);
        expect(a?.code, `${t.label} / ${label} / confirm`).toBe('42501');
        expect(b?.code, `${t.label} / ${label} / correct`).toBe('42501');
        answers.add(a!.message);
        answers.add(b!.message);
      }
      for (const who of [w.accountant, w.driverUserA]) {
        expect(
          (
            await w.failure(
              { user: who.id, role: who.role },
              'select public.confirm_trip_stage($1, $2, now())',
              [t.trip, 'departed'],
            )
          )?.code,
        ).toBe('42501');
        expect(
          (
            await w.failure(
              { user: who.id, role: who.role },
              `select public.correct_trip_stage($1, $2, now(), $3)`,
              [t.trip, 'departed', 'a real reason'],
            )
          )?.code,
        ).toBe('42501');
      }
      expect([await rows(), await corr(), await audit()]).toEqual(before);
    }
    expect([...answers].sort()).toEqual([
      'confirm_trip_stage: not your rotation',
      'correct_trip_stage: not your rotation',
    ]);
    // positive controls on the B rotation
    const b = made[0]!;
    expect(
      await w.as(
        w.owner,
        async (tx) =>
          (
            await tx.query<{ c: boolean }>('select public.confirm_trip_stage($1, $2, now()) as c', [
              b.trip,
              'departed',
            ])
          ).rows[0]!.c,
      ),
    ).toBe(true);
    await w.as(w.owner, (tx) =>
      tx.query(`select public.correct_trip_stage($1, $2, now(), $3)`, [b.trip, 'departed', 'a real reason']),
    );
    expect(await w.count(`select 1 from trip_event_correction where trip_id = '${b.trip}'`)).toBe(1);
  });

  it("the plant manager of the plant still works his own rotation; he cannot touch another plant's or the NULL-plant one (scope unchanged)", async () => {
    const a = await w.newTrip(w.plantA, w.truckA, w.driverA);
    await w.tap(w.driverUserA, a.trip, 'departed');
    expect(
      await w.as(
        w.pmA,
        async (tx) =>
          (
            await tx.query<{ c: boolean }>('select public.confirm_trip_stage($1, $2, now()) as c', [
              a.trip,
              'departed',
            ])
          ).rows[0]!.c,
      ),
    ).toBe(true);
    expect(
      (
        await w.failure(
          { user: w.pmB.id, role: 'plant_manager' },
          'select public.confirm_trip_stage($1, $2, now())',
          [a.trip, 'departed'],
        )
      )?.code,
    ).toBe('42501');
    const n = await w.newTrip(w.plantA, w.truckN, w.driverA, { nullPlant: true });
    await w.tap(w.driverUserA, n.trip, 'departed');
    expect(
      (
        await w.failure(
          { user: w.pmA.id, role: 'plant_manager' },
          'select public.confirm_trip_stage($1, $2, now())',
          [n.trip, 'departed'],
        )
      )?.code,
    ).toBe('42501');
  });
});

describe('R18-02 (found by the catalogue with real ids): the same NULL trap in the transfer/fuel predicate', () => {
  it('set_fuel_tank_opening and the three transfer doors write nothing for a request with a user but no role, on a real plant', async () => {
    const before = [
      await w.count('select 1 from fuel_tank_opening'),
      await w.count('select 1 from audit_event'),
    ];
    for (const ctx of [
      { user: w.pmA.id, role: null },
      { user: w.pmA.id, role: '' },
    ]) {
      const err = await w.failure(ctx, 'select public.set_fuel_tank_opening($1, 5000, current_date)', [
        w.plantB,
      ]);
      expect(err?.code).toBe('42501');
      expect(err?.message).toMatch(/only the plant manager of this plant/);
    }
    // the plant B manager is refused for plant A and allowed for his own (the predicate still works)
    expect(
      (
        await w.failure(
          { user: w.pmB.id, role: 'plant_manager' },
          'select public.set_fuel_tank_opening($1, 5000, current_date)',
          [w.plantA],
        )
      )?.code,
    ).toBe('42501');
    expect([
      await w.count('select 1 from fuel_tank_opening'),
      await w.count('select 1 from audit_event'),
    ]).toEqual(before);
    expect(
      await w.as(
        w.pmB,
        async (tx) =>
          (
            await tx.query<{ r: boolean }>(
              'select public.set_fuel_tank_opening($1, 5000, current_date) as r',
              [w.plantB],
            )
          ).rows[0]!.r,
      ),
    ).toBe(true);
  });
});
