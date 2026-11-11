import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInvoiceQueue } from '../src/modules/ledger';
import { markDelivered } from '../src/modules/operations';
import { testEnv } from './db-env';
import { plantWorld, type World } from './helpers/plant-world';

/**
 * R18-07: the billing gate (delivery_delivered). Plant manager A against REAL loads of plant B and of no plant, A's own unconfirmed driver event and an implicit
 * finish: raw reads and writes fail, the doors answer one way, and the invoice queue and the invoice writer still reject the load.
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 8 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `r7${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let w: World;
const asA = () => ({ user: w.pmA.id, role: 'plant_manager' });
const day = (n: number) => `2096-03-${String(10 + n).padStart(2, '0')}`;

beforeAll(async () => {
  w = await plantWorld(app, migrator, marker);
});
afterAll(async () => {
  await w.done();
  await Promise.all([app.end(), migrator.end()]);
});

/** A rotation with its load linked, taken to the end of the unloading by its driver. */
async function unloaded(
  plant: string,
  truck: string,
  row: string,
  user: never,
  opts: { nullPlant?: boolean; day: string },
) {
  const t = await w.newTrip(plant, truck, row, opts);
  await w.tap(user, t.trip, 'loaded');
  const load = await w.plantLoad(opts.nullPlant ? w.plantA : plant, t.order, truck);
  if (opts.nullPlant) await w.sup(`update delivery set plant_id = null where id = $1`, [load], ['delivery']); // a legacy load names no plant
  await w.as(w.owner, (tx) => tx.query('select public.attach_trip_load($1, $2)', [t.trip, load]));
  for (const s of ['departed', 'arrived', 'unloading_started']) await w.tap(user, t.trip, s);
  await w.tap(user, t.trip, 'unloading_finished', 1000);
  return { ...t, load };
}
const gates = (load: string) => w.count(`select 1 from delivery_delivered where delivery_id = '${load}'`);

describe('R18-07: no raw access to the gate for a plant manager', () => {
  it("reads: A sees the gate rows of his plant's loads only (B and plantless gate rows are invisible, by id too)", async () => {
    const a = await unloaded(w.plantA, w.truckA, w.driverA, w.driverUserA as never, { day: day(1) });
    const b = await unloaded(w.plantB, w.truckB, w.driverB, w.driverUserB as never, { day: day(2) });
    const n = await unloaded(w.plantA, w.truckN, w.driverA, w.driverUserA as never, {
      day: day(3),
      nullPlant: true,
    });
    for (const t of [a, b, n])
      expect(
        await w.as(
          w.owner,
          async (tx) =>
            (await tx.query<{ c: boolean }>('select public.confirm_trip_delivered($1) as c', [t.trip]))
              .rows[0]!.c,
        ),
      ).toBe(true);
    const seen = await w.as(w.pmA, async (tx) =>
      (await tx.query<{ delivery_id: string }>('select delivery_id from delivery_delivered')).rows.map(
        (r) => r.delivery_id,
      ),
    );
    expect(seen).toContain(a.load);
    expect(seen).not.toContain(b.load);
    expect(seen).not.toContain(n.load);
    for (const t of [b, n]) {
      const byId = await w.as(w.pmA, (tx) =>
        tx.query(
          'select * from delivery_delivered where delivery_id = $1 or trip_event_id is not null and delivery_id = $1',
          [t.load],
        ),
      );
      expect(byId.rowCount, 'by id').toBe(0);
    }
    expect(await gates(b.load)).toBe(1); // the rows exist: it is the scope that hides them
  });

  it("writes: the application login cannot INSERT a gate row — not for a foreign load, not for a plantless one, not on A's own unconfirmed driver event, not on an implicit finish", async () => {
    // an unlinked foreign load of B and one of no plant
    const bt = await w.newTrip(w.plantB, w.truckB, w.driverB, { day: day(4) });
    const loadB = await w.plantLoad(w.plantB, bt.order, w.truckB);
    const nt = await w.newTrip(w.plantA, w.truckN, w.driverA, { day: day(5), nullPlant: true });
    const loadN = await w.plantLoad(w.plantA, nt.order, w.truckN);
    await w.sup(`update delivery set plant_id = null where id = $1`, [loadN], ['delivery']); // a legacy load names no plant
    // A's own rotation: the driver declared the unloading (a driver event, unconfirmed)
    const own = await w.newTrip(w.plantA, w.truckA, w.driverA, { day: day(6) });
    await w.tap(w.driverUserA, own.trip, 'loaded');
    const ownLoad = await w.plantLoad(w.plantA, own.order, w.truckA);
    await w.as(w.pmA, (tx) => tx.query('select public.attach_trip_load($1, $2)', [own.trip, ownLoad]));
    for (const s of ['departed', 'arrived', 'unloading_started']) await w.tap(w.driverUserA, own.trip, s);
    await w.tap(w.driverUserA, own.trip, 'unloading_finished', 1000);
    const driverEvent = (
      await w.sup<{ id: string; at: Date }>(
        `select id, at from trip_event where trip_id = $1 and step = 'unloading_finished'`,
        [own.trip],
      )
    )[0]!;
    // an implicit finish: the driver jumps to 'back'
    const imp = await w.newTrip(w.plantA, w.truckA, w.driverA, { day: day(7) });
    await w.tap(w.driverUserA, imp.trip, 'loaded');
    const impLoad = await w.plantLoad(w.plantA, imp.order, w.truckA);
    await w.as(w.pmA, (tx) => tx.query('select public.attach_trip_load($1, $2)', [imp.trip, impLoad]));
    await w.tap(w.driverUserA, imp.trip, 'back');
    const implicitEvent = (
      await w.sup<{ id: string; at: Date; implicit: boolean }>(
        `select id, at, implicit from trip_event where trip_id = $1 and step = 'unloading_finished'`,
        [imp.trip],
      )
    )[0]!;
    expect(implicitEvent.implicit).toBe(true);

    const ins = `insert into delivery_delivered (id, delivery_id, at, trip_event_id, created_by) values (gen_random_uuid(), $1, $2, $3, $4)`;
    const before = await w.count('select 1 from delivery_delivered');
    const attempts: [string, unknown[]][] = [
      ['foreign load by id (hand)', [loadB, new Date(), null, w.pmA.id]],
      ['plantless load by id (hand)', [loadN, new Date(), null, w.pmA.id]],
      ["own load on the DRIVER's unconfirmed event", [ownLoad, driverEvent.at, driverEvent.id, w.pmA.id]],
      ['own load on an implicit finish', [impLoad, implicitEvent.at, implicitEvent.id, w.pmA.id]],
    ];
    for (const [label, args] of attempts) {
      const err = await w.failure(asA(), ins, args);
      expect(err, label).not.toBeNull();
      expect(err!.code, label).toBe('42501'); // no INSERT privilege at all
    }
    expect(await w.count('select 1 from delivery_delivered')).toBe(before);
    // the owner's raw INSERT is closed too: the gate has doors only
    expect(
      (
        await w.failure({ user: w.owner.id, role: 'owner' }, ins, [
          ownLoad,
          driverEvent.at,
          driverEvent.id,
          w.owner.id,
        ])
      )?.code,
    ).toBe('42501');

    // the doors: one answer for a foreign load, a plantless load and a missing load
    const door = 'select public.mark_load_delivered($1, now())';
    const answers = new Set<string>();
    for (const id of [loadB, loadN, randomUUID()]) {
      const err = await w.failure(asA(), door, [id]);
      expect(err?.code).toBe('42501');
      answers.add(err!.message);
    }
    expect([...answers]).toEqual(['mark_load_delivered: not your load']);
    // no role / wrong audience
    for (const ctx of [
      { user: w.pmA.id, role: null },
      { user: w.accountant.id, role: 'accountant' },
      { user: w.driverUserA.id, role: 'driver' },
    ])
      expect((await w.failure(ctx, door, [ownLoad]))?.code).toBe('42501');
    // the plant's own confirmation of a DRIVER's declaration is a different thing: confirm_trip_delivered on an implicit finish is refused (explicit finish only)
    const e = await w.failure(asA(), 'select public.confirm_trip_delivered($1)', [imp.trip]);
    expect(e?.code).toBe('23514');
    expect(e?.message).toMatch(/filled in, not declared/);
    expect(await gates(impLoad)).toBe(0);
    // ...and a foreign trip is the uniform denial
    expect((await w.failure(asA(), 'select public.confirm_trip_delivered($1)', [bt.trip]))?.message).toBe(
      'confirm_trip_delivered: not your rotation',
    );

    // the invoice queue and the invoice writer still reject every one of those loads
    const queue = (await getInvoiceQueue(app, w.owner)).flatMap((c) => c.deliveries).map((d) => d.deliveryId);
    for (const id of [loadB, loadN, ownLoad, impLoad]) {
      expect(queue, id).not.toContain(id);
      // the writer answers NULL (it refuses and audits) and creates no invoice
      const invoicesBefore = await w.count('select 1 from invoice');
      let answer: string | null | undefined;
      await w
        .raw({ user: w.owner.id, role: 'owner' }, async (tx) => {
          answer = (
            await tx.query<{ r: string | null }>(
              `select public.create_invoice_from_deliveries($1::uuid[], current_date + 30, current_date) as r`,
              [[id]],
            )
          ).rows[0]!.r;
          throw new Error('__rolled_back__');
        })
        .catch(() => undefined);
      expect(answer, `invoice writer ${id}`).toBeNull();
      expect(await w.count('select 1 from invoice')).toBe(invoicesBefore);
    }
    expect(await w.count('select 1 from delivery_delivered')).toBe(before);
  });

  it('the legitimate paths still work: the manager marks his own plantless-of-rotation load by hand through the door (once), and the service reports a second call as already delivered', async () => {
    const t = await w.newTrip(w.plantA, w.truckA, w.driverA, { day: day(8) });
    const load = await w.plantLoad(w.plantA, t.order, w.truckA);
    const first = await markDelivered(app, w.pmA, { deliveryId: load }, { now: new Date() });
    expect(first.ok).toBe(true);
    expect(
      await w.count(
        `select 1 from delivery_delivered where delivery_id = '${load}' and via = 'hand' and created_by = '${w.pmA.id}'`,
      ),
    ).toBe(1);
    const again = await markDelivered(app, w.pmA, { deliveryId: load }, { now: new Date() });
    expect(again).toEqual({ ok: false, error: 'ALREADY_DELIVERED' });
    // a manager of another plant gets NOT_FOUND for it
    const t2 = await w.newTrip(w.plantB, w.truckB, w.driverB, { day: day(9) });
    const loadB = await w.plantLoad(w.plantB, t2.order, w.truckB);
    expect(await markDelivered(app, w.pmA, { deliveryId: loadB }, { now: new Date() })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await gates(loadB)).toBe(0);
  });

  it("attach_trip_load links only a load of the rotation's own order and plant", async () => {
    const t = await w.newTrip(w.plantA, w.truckA, w.driverA, { day: day(10) });
    await w.tap(w.driverUserA, t.trip, 'loaded');
    const other = await w.newTrip(w.plantB, w.truckB, w.driverB, { day: day(10) });
    const foreignLoad = await w.plantLoad(w.plantB, other.order, w.truckB);
    const err = await w.failure(asA(), 'select public.attach_trip_load($1, $2)', [t.trip, foreignLoad]);
    expect(err?.message).toBe('attach_trip_load: not your rotation');
    expect(
      await w.count(`select 1 from trip_event where trip_id = '${t.trip}' and delivery_id is not null`),
    ).toBe(0);
  });
});
