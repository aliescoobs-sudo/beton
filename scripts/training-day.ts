// The working day of the training instance (T5). Everything is dated from the business day it is given ("today"), so the trainees
// always find work to do: orders to dispatch, rotations in sequence for the three phone drivers, quotes to turn into orders, an order
// to cancel, a delivery to receive, a low-stock alert. It is used by the seed (once, at the end) and by `rearm:training` (any morning).
// Fictitious data only, written through the application's own services as the training accounts' roles: the same rules, row-level
// security and audit as a screen entry. Not an entry point.
import pg from 'pg';
import { withRlsContext } from '../src/lib/db/rls-context.ts';
import { realClock } from '../src/modules/clock/index.ts';
import { insertLoadRows } from '../src/modules/operations/service/delivery-service.ts';
import { minuteOfDay } from '../src/modules/operations/domain/trip-times.ts';
import { setParameter } from '../src/modules/platform-security/service/parameter-service.ts';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security/auth/actors.ts';
import { createOrder, createPurchase, createQuote } from '../src/modules/ledger/index.ts';
import {
  cancelUnproducedOrder,
  saveDispatch,
  setStockThreshold,
  setTripEstimate,
  setTruckDefaultDriver,
} from '../src/modules/operations/index.ts';
import {
  listClients,
  listComponents,
  listConcreteTypes,
  listPlants,
  listTrucks,
  listZones,
} from '../src/modules/master-data/index.ts';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate.ts';
import { emailOf } from './training-lib.ts';

export interface DayEnv {
  DATABASE_URL_APP: string;
  DATABASE_URL_MIGRATOR: string;
  /** The seed login: writes the rotation that is already on the road (the plant's own rows), as the pilot scenario does. */
  DATABASE_URL_SEED?: string;
}
export interface ArmedDay {
  date: string;
  ordersCreated: number;
  ordersCancelled: number;
  rotationsPlanned: number;
  /** A rotation already on the road and running late was set up (a critical alert is visible on the board). */
  lateRotation: boolean;
}

class DayError extends Error {}
const must = <T>(label: string, r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new DayError(`training day: ${label} failed (${r.error})`);
  return r.value;
};
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Brings the training day up to date. Safe to run again: it first cancels (reversing entry, through the service) the Tétouan orders
 * due today that nothing was loaded for, then creates the day's work again and replans the rotations that have not started; whatever a
 * trainee already started or finished stays. The accounts and their passwords are never touched.
 */
export async function armTrainingDay(
  env: DayEnv,
  today: string,
  /** The seed calls it before its own marker is written (the marker stays the last write); a re-arm needs the marker. */
  opts: { requireMarker?: boolean } = {},
): Promise<ArmedDay> {
  const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
  const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
  const seed = env.DATABASE_URL_SEED
    ? new pg.Pool({ connectionString: env.DATABASE_URL_SEED, max: 1 })
    : null;
  try {
    if (
      (opts.requireMarker ?? true) &&
      !(await migrator.query('select 1 from public.training_marker')).rowCount
    )
      throw new DayError(
        'training day: this database carries no training marker; arm a database the training seed completed',
      );
    const asUser = async (login: string, plantId: string | null = null): Promise<SessionUser> => {
      const { rows } = await migrator.query<{ id: string; name: string; email: string; role: string }>(
        `select id, name, email, role from "user" where lower(email) = $1`,
        [emailOf(login)],
      );
      const u = rows[0];
      if (!u) throw new DayError(`training day: the account ${login} does not exist`);
      return {
        ...u,
        locale: 'fr',
        twoFactorEnabled: false,
        reenrolRequired: false,
        stepUpVerified: true,
        ...(plantId ? { plantId } : {}),
      } as unknown as SessionUser;
    };
    const owner = await asUser('proprietaire');
    const plants = await listPlants(app, owner);
    const tet = plants.find((p) => p.code === 'TETOUAN');
    const chf = plants.find((p) => p.code === 'CHEFCHN');
    if (!tet || !chf) throw new DayError('training day: the two plants are missing');
    const managerTet = await asUser('centrale-tetouan', tet.id);
    const managerChf = await asUser('centrale-chefchaouen', chf.id);
    const sales = await asUser('ventes');
    const purchases = await asUser('achats');

    const clients = (await listClients(app, owner))
      .filter((c) => c.name.startsWith('Client Démo'))
      .sort((a, b) => a.name.localeCompare(b.name));
    const types = await listConcreteTypes(app, owner);
    const typeId = (code: string) => types.find((t) => t.code === code)!.id;
    const zones = (await listZones(app, owner)).sort((a, b) => a.oneWayMin - b.oneWayMin);
    if (clients.length < 4 || zones.length < 3)
      throw new DayError('training day: the base data (4 clients, 3 zones) is missing');

    // 0. The three phone drivers drive the first three Tétouan trucks (default drivers: the plan proposes them).
    const drivers = (
      await migrator.query<{ id: string; code: string }>(
        `select id, code from driver where kind = 'driver' and status = 'active' order by code limit 3`,
      )
    ).rows;
    const tetTrucks = (await listTrucks(app, owner))
      .filter((t) => t.kind === 'mixer' && t.plantId === tet.id)
      .sort((a, b) => a.code.localeCompare(b.code));
    const crew = tetTrucks.slice(0, 3).map((truck, i) => ({ truck, driver: drivers[i]! }));
    for (const c of crew)
      must(
        `default driver ${c.truck.code}`,
        await setTruckDefaultDriver(app, owner, { truckId: c.truck.id, driverId: c.driver.id }),
      );

    // 1. A clean day: yesterday's leftovers that nothing was loaded for are cancelled; a re-arm starts from here.
    const stale = await migrator.query<{ id: string }>(
      `select o.id from sales_order o
        where o.delivery_date = $1 and o.plant_id = $2 and o.reverses_id is null
          and not exists (select 1 from sales_order r where r.reverses_id = o.id)
          and not exists (select 1 from delivery d where d.order_id = o.id)`,
      [today, tet.id],
    );
    let cancelled = 0;
    for (const o of stale.rows) {
      const r = await cancelUnproducedOrder(
        app,
        owner,
        { orderId: o.id, reason: 'Journée de formation renouvelée' },
        { today },
      );
      if (r.ok) cancelled++;
    }

    // 2. Tétouan's day: four orders for today (cash, cheque, instalments, advance), different zones. The first three are planned in
    //    sequence on the three trucks; the fourth is left for the plant manager to dispatch.
    const plan = ['cash', 'cheque30', 'installments3', 'advance50'] as const;
    const volumes = [32_000, 32_000, 32_000, 16_000]; // litres: 2 + 2 + 2 + 1 rotations of 16 m³
    const types4 = ['B25', 'B20', 'B30', 'B25'];
    const orders = [];
    for (let i = 0; i < 4; i++)
      orders.push(
        must(
          `order ${i + 1}`,
          await createOrder(
            app,
            sales,
            {
              clientId: clients[i]!.id,
              plantId: tet.id,
              zoneId: zones[i % 3]!.id,
              concreteTypeId: typeId(types4[i]!),
              dischargeMethod: 'GOULOTTE',
              volumeL: volumes[i],
              deliveryDate: today,
              plan: { preset: plan[i] },
            },
            { today },
          ),
        ),
      );
    // 2b. T5 phase 2: the plan starts a quarter of an hour from now (a day started in the morning is not "late" for the whole afternoon),
    //     and one rotation is already on the road and running late, so that a critical alert is visible as soon as a trainee looks.
    const nowMin = minuteOfDay(realClock.now().toISOString());
    await setParameter(
      app,
      owner,
      'day_start_min',
      nowMin >= 420 && nowMin <= 1020 ? Math.min(1020, Math.ceil((nowMin + 15) / 15) * 15) : 420,
    );
    const lateRotation = seed
      ? await seedLateRotation(app, seed, migrator, owner, crew[2]!, {
          tetId: tet.id,
          today,
          nowMin,
          clientId: clients[3]!.id,
          typeId: typeId('B20'),
          zoneId: zones[1]!.id,
          sales,
        })
      : false;

    // rotations of the first three orders dealt to the crew in turn: each driver gets 2 or 3 deliveries in sequence
    const rotations: { orderId: string; truckId: string; driverId: string; volumeL: number }[] = [];
    let n = 0;
    for (let i = 0; i < 3; i++)
      for (let k = 0; k < volumes[i]! / 16_000; k++) {
        const c = crew[n++ % 3]!;
        rotations.push({
          orderId: orders[i]!.id,
          truckId: c.truck.id,
          driverId: c.driver.id,
          volumeL: 16_000,
        });
      }
    const saved = must(
      'dispatch Tétouan',
      await saveDispatch(app, managerTet, { date: today, rotations }, { today }),
    );

    // 3. Chefchaouen: one more order today for its manager to dispatch (the seed already holds the pumped one).
    must(
      'order Chefchaouen',
      await createOrder(
        app,
        sales,
        {
          clientId: clients[2]!.id,
          plantId: chf.id,
          zoneId: zones[1]!.id,
          concreteTypeId: typeId('B25'),
          dischargeMethod: 'GOULOTTE',
          volumeL: 22_000,
          deliveryDate: today,
          plan: { preset: 'cash' },
        },
        { today },
      ),
    );

    // 4. Office sales: two quotes to turn into orders, and an order for tomorrow, never produced, to cancel.
    for (const [i, vol] of [
      [0, 12_000],
      [3, 24_000],
    ] as const)
      must(
        `quote ${i}`,
        await createQuote(
          app,
          sales,
          { clientId: clients[i]!.id, concreteTypeId: typeId('B25'), volumeL: vol },
          { today },
        ),
      );
    must(
      'order to cancel',
      await createOrder(
        app,
        sales,
        {
          clientId: clients[1]!.id,
          plantId: tet.id,
          concreteTypeId: typeId('B20'),
          dischargeMethod: 'GOULOTTE',
          volumeL: 8_000,
          deliveryDate: addDays(today, 1),
          plan: { preset: 'cash' },
        },
        { today },
      ),
    );

    // 5. Low stock at Tétouan (an alert for the manager and an order to place for purchases): the cement threshold is above the stock.
    const cement = (await listComponents(app, owner)).find((c) => c.nameFr === 'Ciment')!;
    const have = await migrator.query(
      `select 1 from stock_threshold where component_id = $1 and plant_id = $2`,
      [cement.id, tet.id],
    );
    if (!have.rowCount)
      must(
        'cement threshold',
        await setStockThreshold(app, { ...owner, plantId: tet.id } as SessionUser, {
          componentId: cement.id,
          lowQtyBase: 900_000_000,
          plantId: tet.id,
        }),
      );

    // 6. Office purchases: a delivery of cement expected at Tétouan, to receive.
    const supplier = (
      await migrator.query<{ id: string }>(`select id from supplier where name = 'Ciment Démo'`)
    ).rows[0];
    const unit = (
      await migrator.query<{ id: string }>(
        `select id from purchase_unit where component_id = $1 and label = 't'`,
        [cement.id],
      )
    ).rows[0];
    if (supplier && unit)
      must(
        'purchase to receive',
        await createPurchase(
          app,
          purchases,
          {
            supplierId: supplier.id,
            plantId: tet.id,
            lines: [
              {
                componentId: cement.id,
                purchaseUnitId: unit.id,
                qtyMilli: 30_000,
                unitPriceHtCentimes: 145_000,
              },
            ],
          },
          { today },
        ),
      );
    // 7. The timing history and overrides (T5 phase 2): the delays of every completed rotation of the seed, as if each tap had been recorded,
    //    so that the estimates (medians of the last completed rotations) and the statistics have something to show; and one estimate override.
    await backfillTripDelays(migrator);
    const oued = zones.find((z) => z.name === 'Oued Laou');
    if (oued)
      await setTripEstimate(app, managerTet, {
        plantId: tet.id,
        zoneId: oued.id,
        stage: 'to_site',
        minutes: 70,
        reason: 'Route de la corniche en travaux',
      });
    return {
      date: today,
      ordersCreated: 6,
      ordersCancelled: cancelled,
      rotationsPlanned: saved.rotations,
      lateRotation,
    };
  } finally {
    await Promise.all([app.end(), migrator.end(), seed?.end()]);
  }
}

/**
 * One rotation of the Tétouan truck T3 and its driver, already on the road and running late: loaded and departed 28
 * minutes after its plan, so that, with the estimates, its return slips past the start of the truck's next rotation (planned from its
 * back). Written the way the pilot scenario writes history (the plant's own rows), in the system's name. Skipped before 01:25 local time
 * (the rotation would have to start yesterday) and when the driver already has a rotation on the road.
 */
async function seedLateRotation(
  app: pg.Pool,
  seed: pg.Pool,
  migrator: pg.Pool,
  owner: SessionUser,
  crew: { truck: { id: string }; driver: { id: string } },
  o: {
    tetId: string;
    today: string;
    nowMin: number;
    clientId: string;
    typeId: string;
    zoneId: string;
    sales: SessionUser;
  },
): Promise<boolean> {
  if (o.nowMin < 85) return false;
  const running = await migrator.query(
    `select 1 from trip_plan p where p.driver_id = $1 and p.trip_date = $2
        and exists (select 1 from trip_event e where e.trip_id = p.id and e.step = 'departed')
        and not exists (select 1 from trip_event e where e.trip_id = p.id and e.step = 'back')
        and not exists (select 1 from trip_plan_cancellation c where c.trip_id = p.id)`,
    [crew.driver.id, o.today],
  );
  if (running.rowCount) return false;
  const order = must(
    'late order',
    await createOrder(
      app,
      o.sales,
      {
        clientId: o.clientId,
        plantId: o.tetId,
        zoneId: o.zoneId,
        concreteTypeId: o.typeId,
        dischargeMethod: 'GOULOTTE',
        volumeL: 16_000,
        deliveryDate: o.today,
        plan: { preset: 'cash' },
      },
      { today: o.today },
    ),
  );
  const at = (minute: number) => new Date(realClock.now().getTime() - (o.nowMin - minute) * 60_000);
  const m = o.nowMin;
  try {
    await withRlsContext(
      seed,
      { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: 'training-late-rotation' },
      async (tx) => {
        await tx.query(`select set_config('app.plant_id', $1, true)`, [o.tetId]);
        const recette = (
          await tx.query<{ id: string }>(`select public.recette_in_force($1, $2, $3::date) as id`, [
            o.typeId,
            o.tetId,
            o.today,
          ])
        ).rows[0]?.id;
        if (!recette) throw new DayError('training day: no recette in force for the late rotation');
        const trip = (
          await tx.query<{ id: string }>(
            `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min,
                                unload_end_min, back_min, created_by)
         values (gen_random_uuid(), gen_random_uuid(), $1, $2, 1, $3, $4, 16000, $5, $6, $7, $8, $9, $10) returning id`,
            [
              o.today,
              order.id,
              crew.truck.id,
              crew.driver.id,
              m - 80,
              m - 70,
              m - 40,
              m - 10,
              m + 20,
              SYSTEM_ACTOR_ID,
            ],
          )
        ).rows[0]!.id;
        const load = await insertLoadRows(
          tx,
          { id: SYSTEM_ACTOR_ID },
          {
            orderId: order.id,
            truckId: crew.truck.id,
            volumeL: 16_000,
            date: o.today,
            recetteId: recette,
            loadedAt: at(m - 75).toISOString(),
          },
        );
        await tx.query(
          `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values (gen_random_uuid(), $1, 'loaded', $2, $3, $4)`,
          [trip, at(m - 75), load.id, SYSTEM_ACTOR_ID],
        );
        // departed 28 minutes after the plan (planned m-70, tapped m-42)
        await tx.query(
          `insert into trip_event (id, trip_id, step, at, created_by) values (gen_random_uuid(), $1, 'departed', $2, $3)`,
          [trip, at(m - 42), SYSTEM_ACTOR_ID],
        );
      },
    );
  } catch (error) {
    // The client's credit is used up by earlier arms: the order is held for the owner's approval and cannot be loaded. The order stays as
    // an item for the owner to release; there is no late rotation this time.
    if (/waiting for approval/.test(String((error as Error).message))) return false;
    throw error;
  }
  return true;
}

/**
 * The delay of every tap already recorded as an event (the seed's completed rotations and the late one), as `driver_report` would have
 * stored it. Maintenance login, fictitious data, only for taps that have no delay row yet.
 */
export async function backfillTripDelays(migrator: pg.Pool): Promise<number> {
  return withRlsContext(
    migrator,
    { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: 'training-delay-history' },
    async (tx) => {
      const r = await tx.query(
        `insert into trip_delay (id, trip_id, driver_id, plant_id, trip_date, zone_id, step, planned_at, tapped_at, stage_delay_min, cumulative_delay_min, created_by)
       select gen_random_uuid(), x.trip_id, x.driver_id, x.plant_id, x.trip_date, x.zone_id, x.step, x.planned_at, x.at,
              round(extract(epoch from ((x.at - lag(x.at) over w) - (x.planned_at - lag(x.planned_at) over w))) / 60)::int,
              round(extract(epoch from (x.at - x.planned_at)) / 60)::int, $1
         from (select p.id as trip_id, p.driver_id, p.plant_id, p.trip_date, o.zone_id, e.step, e.at,
                      public._plan_time(p.trip_date, case e.step when 'departed' then p.depart_min when 'arrived' then p.arrive_min
                        when 'unloading_started' then p.arrive_min when 'unloading_finished' then p.unload_end_min else p.back_min end) as planned_at
                 from public.trip_plan p
                 join public.sales_order o on o.id = p.order_id
                 join public.trip_event e on e.trip_id = p.id
                where p.driver_id is not null
                  and e.step in ('departed', 'arrived', 'unloading_started', 'unloading_finished', 'back')
                  and not exists (select 1 from public.trip_delay d where d.trip_id = p.id and d.step = e.step)) x
       window w as (partition by x.trip_id order by array_position(array['departed', 'arrived', 'unloading_started', 'unloading_finished', 'back'], x.step))
       on conflict (trip_id, step) do nothing`,
        [SYSTEM_ACTOR_ID],
      );
      return r.rowCount ?? 0;
    },
  );
}
