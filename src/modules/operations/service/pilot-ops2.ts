import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { addDaysIso, createRng, type Rng } from '@/modules/ledger';
import { assertSeedAllowed, type SeedGuardEnv } from '@/modules/master-data';
import { parameterOrDefault, SYSTEM_ACTOR_ID } from '@/modules/platform-security';
import {
  type DispatchDriver,
  type DispatchOrder,
  type DispatchParams,
  type DispatchTruck,
  planDispatch,
  type Rotation,
  rotationTimes,
} from '../domain/dispatch';
import { minuteOfDay } from '../domain/trip-times';

type Tx = pg.PoolClient;

const SEED = 20_261_026;
const WEEKS = 8;

export interface Wave2Result {
  applied: boolean;
  drivers: number;
  rotations: number;
  events: number;
  plannedAhead: number;
  counts: number;
  fills: number;
  fuelPurchases: number;
  losses: number;
}

const NOTHING: Wave2Result = {
  applied: false,
  drivers: 0,
  rotations: 0,
  events: 0,
  plannedAhead: 0,
  counts: 0,
  fills: 0,
  fuelPurchases: 0,
  losses: 0,
};

const DRIVERS = ['Karim', 'Youssef', 'Hamid', 'Saïd', 'Rachid', 'Omar', 'Ayoub', 'Nabil'];
/** Calendar days a supplier of each category takes from order to receipt (fake, a 🟡 to confirm with the plant). */
const LEAD_DAYS: Record<string, number> = { cement: 3, aggregates: 2, admixture: 4, transport: 1, fuel: 1 };

/** The parameters of the dispatch at their defaults: the scenario runs as the seed role, which does not read the parameter table. */
const dispatchParams = (): DispatchParams => {
  const n = (key: Parameters<typeof parameterOrDefault>[0]): number =>
    Number(parameterOrDefault(key, undefined));
  return {
    dayStartMin: n('day_start_min'),
    loadingMin: n('loading_min'),
    unloadingMin: n('unloading_min'),
    returnExtraMin: n('return_extra_min'),
    workingMin: n('working_min'),
    concreteLimitMin: n('concrete_limit_min'),
    defaultOneWayMin: n('default_one_way_min'),
  };
};

/** The instant at which Casablanca's clock shows `minute` on `date` (so the planned and the recorded times read alike). */
function localInstant(date: string, minute: number): string {
  const guess = Date.parse(`${date}T00:00:00Z`) + minute * 60_000;
  const shown = minuteOfDay(new Date(guess).toISOString());
  let off = shown - (((minute % 1440) + 1440) % 1440);
  if (off > 720) off -= 1440;
  if (off < -720) off += 1440;
  return new Date(guess - off * 60_000).toISOString();
}

const naturalCode = (a: { code: string }, b: { code: string }): number =>
  a.code.localeCompare(b.code, 'en', { numeric: true });

interface LoadRow {
  id: string;
  order_id: string;
  truck_id: string;
  volume_l: number;
  load_date: string;
  one_way: number | null;
}

/**
 * Rotations for the loads of the last two weeks: each live load becomes a planned rotation (its truck, the driver paired to
 * that truck, times from the zone and the parameters, a truck never doing two at once) and a tracked one (loaded, departed,
 * arrived, waiting on site, unloading, back; today's are still on the road). The waits vary, a few are long.
 */
async function seedRotations(
  tx: Tx,
  today: string,
  rng: Rng,
  drivers: { id: string; code: string }[],
  trucks: { id: string; code: string }[],
): Promise<{ rotations: number; events: number }> {
  const p = dispatchParams();
  const driverOfTruck = new Map<string, string>();
  [...trucks].sort(naturalCode).forEach((t, i) => {
    const d = [...drivers].sort(naturalCode)[i];
    if (d) driverOfTruck.set(t.id, d.id);
  });
  const loads = (
    await tx.query<LoadRow>(
      `select d.id, d.order_id, d.truck_id, d.volume_l, to_char(d.load_date, 'YYYY-MM-DD') as load_date, z.one_way_min as one_way
         from delivery d
         join sales_order o on o.id = d.order_id
         left join zone z on z.id = o.zone_id
        where d.reverses_id is null and d.load_date >= $1::date - 14 and d.load_date <= $2
          and not exists (select 1 from delivery c where c.reverses_id = d.id)
        order by d.load_date, d.created_at, d.bl_no`,
      [today, today],
    )
  ).rows;
  let rotations = 0;
  let events = 0;
  const byDay = new Map<string, LoadRow[]>();
  for (const l of loads) byDay.set(l.load_date, [...(byDay.get(l.load_date) ?? []), l]);
  for (const [date, rows] of byDay) {
    const batch = randomUUID();
    const freeAt = new Map<string, number>();
    const seq = new Map<string, number>();
    for (const l of rows) {
      const start = Math.max(freeAt.get(l.truck_id) ?? p.dayStartMin + rng.int(0, 25), p.dayStartMin);
      const times = rotationTimes(start, l.one_way ?? p.defaultOneWayMin, p);
      freeAt.set(l.truck_id, times.backMin + rng.int(0, 10));
      const n = (seq.get(l.order_id) ?? 0) + 1;
      seq.set(l.order_id, n);
      const tripId = randomUUID();
      await tx.query(
        `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min,
                                arrive_min, unload_end_min, back_min, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          tripId,
          batch,
          date,
          l.order_id,
          n,
          l.truck_id,
          driverOfTruck.get(l.truck_id) ?? null,
          l.volume_l,
          times.loadMin,
          times.departMin,
          times.arriveMin,
          times.unloadEndMin,
          times.backMin,
          SYSTEM_ACTOR_ID,
        ],
      );
      rotations += 1;
      // What really happened: a small delay at departure, a wait on site that varies (one in six is long), unloading, the way back.
      const oneWay = l.one_way ?? p.defaultOneWayMin;
      const depart = times.departMin + rng.int(-3, 12);
      const arrive = depart + oneWay + rng.int(-4, 10);
      const wait = rng.next() < 0.17 ? rng.int(35, 70) : rng.int(0, 22);
      const unloadStart = arrive + wait;
      const unloadEnd = unloadStart + p.unloadingMin + rng.int(-6, 12);
      const back = unloadEnd + oneWay + p.returnExtraMin + rng.int(-4, 10);
      const steps: [string, number, string | null][] = [
        ['loaded', times.loadMin, l.id],
        ['departed', depart, null],
        ['arrived', arrive, null],
        ['unloading_started', unloadStart, null],
        ['unloading_finished', unloadEnd, null],
        ['back', back, null],
      ];
      // Today's rotations are still on the road: loaded and departed.
      for (const [step, minute, deliveryId] of date === today ? steps.slice(0, 2) : steps) {
        await tx.query(
          `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), tripId, step, localInstant(date, minute), deliveryId, SYSTEM_ACTOR_ID],
        );
        events += 1;
      }
    }
  }
  return { rotations, events };
}

/** The plan of today and of the next day that has orders: what the proposal gives for the orders still to load, saved. */
async function seedPlannedAhead(
  tx: Tx,
  today: string,
  drivers: DispatchDriver[],
  trucks: { id: string; code: string; capacity_l: number }[],
): Promise<number> {
  const p = dispatchParams();
  let made = 0;
  for (const date of [today, addDaysIso(today, 1), addDaysIso(today, 2)]) {
    const orders = (
      await tx.query<{
        id: string;
        code: string;
        client_code: string;
        label: string;
        site_label: string | null;
        zone_name: string | null;
        one_way: number | null;
        volume_l: number;
        loaded_l: string;
      }>(
        `select o.id, o.code, c.code as client_code, t.label, null::text as site_label, z.name as zone_name, z.one_way_min as one_way,
                o.volume_l, coalesce((select sum(d.volume_l) from delivery d where d.order_id = o.id), 0)::text as loaded_l
           from sales_order o
           join client c on c.id = o.client_id
           join concrete_type t on t.id = o.concrete_type_id
           left join zone z on z.id = o.zone_id
          where o.reverses_id is null
            and (o.delivery_date = $1 or ($1::date = $2::date and o.delivery_date < $1 and o.delivery_date >= $1::date - 14))
            and not exists (select 1 from sales_order r where r.reverses_id = o.id)
          order by o.delivery_date, o.code`,
        [date, today],
      )
    ).rows;
    const dayOrders: DispatchOrder[] = orders
      .map((o) => ({
        orderId: o.id,
        orderCode: o.code,
        clientCode: o.client_code,
        typeLabel: o.label,
        siteLabel: o.site_label,
        zoneName: o.zone_name,
        oneWayMin: o.one_way,
        remainingL: Math.max(0, o.volume_l - Number(o.loaded_l)),
      }))
      .filter((o) => o.remainingL > 0);
    if (dayOrders.length === 0) continue;
    // Rotations that already started today keep their trucks busy.
    const started = (
      await tx.query<{ truck_id: string; back_min: number }>(
        `select p.truck_id, p.back_min from trip_plan p where p.trip_date = $1
            and exists (select 1 from trip_event e where e.trip_id = p.id)`,
        [date],
      )
    ).rows;
    const fixed: Rotation[] = started.map((r, i) => ({
      key: `f${i}`,
      orderId: 'x',
      seq: 1,
      truckId: r.truck_id,
      driverId: null,
      volumeL: 0,
      loadMin: r.back_min,
      departMin: r.back_min,
      arriveMin: r.back_min,
      unloadEndMin: r.back_min,
      backMin: r.back_min,
    }));
    const plan = planDispatch(
      dayOrders,
      trucks.map<DispatchTruck>((t) => ({
        id: t.id,
        code: t.code,
        capacityL: t.capacity_l,
        available: true,
      })),
      drivers,
      p,
      fixed,
    );
    const batch = randomUUID();
    for (const r of plan.rotations) {
      await tx.query(
        `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min,
                                arrive_min, unload_end_min, back_min, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          randomUUID(),
          batch,
          date,
          r.orderId,
          r.seq,
          r.truckId,
          r.driverId,
          r.volumeL,
          r.loadMin,
          r.departMin,
          r.arriveMin,
          r.unloadEndMin,
          r.backMin,
          SYSTEM_ACTOR_ID,
        ],
      );
      made += 1;
    }
  }
  return made;
}

/**
 * A physical count every Saturday of the last weeks: what the count finds against the books is a small share of what the week
 * consumed (cement within the tolerance, sand regularly above it, a gain on the admixture), written as count adjustments.
 */
async function seedCounts(tx: Tx, today: string, rng: Rng): Promise<number> {
  const components = (
    await tx.query<{ id: string; name_fr: string }>(
      `select id, name_fr from component where status = 'active' order by code`,
    )
  ).rows;
  // The last Saturdays before today.
  const saturdays: string[] = [];
  for (let d = addDaysIso(today, -1); saturdays.length < 4; d = addDaysIso(d, -1)) {
    if (new Date(`${d}T00:00:00Z`).getUTCDay() === 6) saturdays.push(d);
  }
  const share: Record<string, [number, number]> = {
    Ciment: [-130, 40],
    Sable: [-480, 90],
    'Gravette 8/15': [-60, 80],
    'Gravette 15/25': [-110, 70],
    Adjuvant: [80, 60],
  };
  let made = 0;
  for (const date of saturdays.reverse()) {
    for (const c of components) {
      const [base, noise] = share[c.name_fr] ?? [-50, 50];
      const used = await tx.query<{ c: string }>(
        `select coalesce(-sum(qty_base), 0)::text as c from stock_movement
          where component_id = $1 and source in ('delivery', 'reversal') and movement_date > $2::date - 7 and movement_date <= $2`,
        [c.id, date],
      );
      const consumed = Number(used.rows[0]?.c ?? 0);
      if (consumed <= 0) continue;
      // basis points of the week's consumption (positive: the count found more than the books)
      const bp = base + rng.int(-noise, noise);
      const adjustment = Math.round((consumed * bp) / 10_000);
      if (adjustment === 0) continue;
      await tx.query(
        `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, reason, created_by)
         values ($1, $2, $3, $4, 'count_adjustment', $1, $5, $6)`,
        [randomUUID(), c.id, date, adjustment, 'Inventaire du samedi (fictif)', SYSTEM_ACTOR_ID],
      );
      made += 1;
    }
  }
  return made;
}

/**
 * One count that finds a big gap on the 15/25 gravel (the pile partly taken to another site): the consumption report flags
 * it, and the stock left covers only a couple of days of the open orders, so the cover screen has a reorder to suggest. Its
 * own idempotence, so that it also completes a scenario seeded before it existed.
 */
async function seedGravelGap(tx: Tx, today: string): Promise<boolean> {
  const done = await tx.query(
    `select 1 from stock_movement where source = 'count_adjustment' and reason like 'Inventaire : tas de gravette%' limit 1`,
  );
  if (done.rows.length > 0) return false;
  const gravel = (
    await tx.query<{ id: string }>(
      `select id from component where name_fr = 'Gravette 15/25' and status = 'active'`,
    )
  ).rows[0];
  if (!gravel) return false;
  const row = await tx.query<{ level: string; used14: string }>(
    `select coalesce(sum(qty_base), 0)::text as level,
            coalesce(-sum(qty_base) filter (where source in ('delivery', 'reversal') and movement_date > $2::date - 14), 0)::text as used14
       from stock_movement where component_id = $1`,
    [gravel.id, today],
  );
  const level = Number(row.rows[0]?.level ?? 0);
  const target = Math.round((Number(row.rows[0]?.used14 ?? 0) * 0.12) / 1000) * 1000;
  if (level <= target || target <= 0) return false;
  await tx.query(
    `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, reason, created_by)
     values ($1, $2, $3, $4, 'count_adjustment', $1, $5, $6)`,
    [
      randomUUID(),
      gravel.id,
      addDaysIso(today, -1),
      target - level,
      'Inventaire : tas de gravette 15/25 en partie évacué (fictif)',
      SYSTEM_ACTOR_ID,
    ],
  );
  return true;
}

/** Fuel: a fill per truck every week with the odometer, and fuel bought in bulk every three weeks (fake prices). */
async function seedFuel(
  tx: Tx,
  today: string,
  rng: Rng,
  trucks: { id: string; code: string }[],
): Promise<{ fills: number; purchases: number }> {
  let fills = 0;
  for (const [i, t] of [...trucks].sort(naturalCode).entries()) {
    let odometer = 140_000 + i * 9_000 + rng.int(0, 4000);
    for (let w = WEEKS; w >= 1; w--) {
      const date = addDaysIso(today, -(w * 7) + (i % 5));
      if (date >= today) continue;
      odometer += rng.int(900, 1500);
      const litresMl = rng.int(150, 235) * 1000 + rng.int(0, 9) * 100;
      // one fill in five is at a station
      await tx.query(
        `insert into fuel_fill (id, truck_id, filled_on, litres_ml, odometer_km, source, created_by)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          t.id,
          date,
          litresMl,
          odometer,
          rng.next() < 0.2 ? 'station' : 'tank',
          SYSTEM_ACTOR_ID,
        ],
      );
      fills += 1;
    }
  }
  let purchases = 0;
  for (let k = 0; k < 3; k++) {
    const litres = rng.int(3500, 4600);
    // 11,90 to 12,80 MAD per litre, as centimes
    const perLitre = rng.int(1190, 1280);
    await tx.query(
      `insert into fuel_purchase (id, purchased_on, litres_ml, total_centimes, created_by) values ($1, $2, $3, $4, $5)`,
      [randomUUID(), addDaysIso(today, -(k * 21 + 6)), litres * 1000, litres * perLitre, SYSTEM_ACTOR_ID],
    );
    purchases += 1;
  }
  return { fills, purchases };
}

/** A few loads sent back or refused in the last weeks, with the reason; one of them a part of the load. */
async function seedLosses(tx: Tx, today: string, rng: Rng): Promise<number> {
  const loads = (
    await tx.query<{ id: string; volume_l: number }>(
      `select d.id, d.volume_l from delivery d
        where d.reverses_id is null and d.load_date >= $1::date - 21 and d.load_date < $1
          and not exists (select 1 from delivery c where c.reverses_id = d.id)
        order by d.load_date, d.bl_no`,
      [today],
    )
  ).rows;
  if (loads.length === 0) return 0;
  const reasons = [
    'rejected_by_client',
    'too_old',
    'quality',
    'returned_unused',
    'rejected_by_client',
  ] as const;
  let made = 0;
  const step = Math.max(1, Math.floor(loads.length / reasons.length));
  for (const [i, reason] of reasons.entries()) {
    const l = loads[Math.min(loads.length - 1, i * step + rng.int(0, Math.max(0, step - 1)))];
    if (!l) continue;
    const volume = i === 1 ? Math.max(1000, Math.round(l.volume_l / 2000) * 1000) : l.volume_l;
    await tx.query(
      `insert into delivery_loss (id, delivery_id, volume_l, reason, note, created_by)
       values ($1, $2, $3, $4, $5, $6) on conflict (delivery_id) do nothing`,
      [randomUUID(), l.id, Math.min(volume, l.volume_l), reason, 'Cas du scénario (fictif)', SYSTEM_ACTOR_ID],
    );
    made += 1;
  }
  return made;
}

/**
 * The second wave of the operations scenario (SPEC-operations §7, fake data only): drivers, supplier lead times, the day's
 * rotations planned and tracked (the last two weeks, with waiting times), the plan of the next days, weekly counts that give
 * the consumption report a flagged variance, fuel fills and purchases, and a few refused loads. Runs after
 * `seedOperationsScenario` as the seed role, every row audited as system/seed. Idempotent: nothing is written once a driver
 * exists.
 */
export async function seedOperationsWave2(
  seedPool: pg.Pool,
  env: SeedGuardEnv,
  today: string,
): Promise<Wave2Result> {
  assertSeedAllowed(env);
  return withRlsContext(
    seedPool,
    { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: 'seed-scenario-ops2' },
    async (tx): Promise<Wave2Result> => {
      const seeded = await tx.query('select 1 from driver limit 1');
      if (seeded.rows.length > 0) {
        const gap = await seedGravelGap(tx, today);
        return gap ? { ...NOTHING, applied: true, counts: 1 } : NOTHING;
      }
      const hasLoads = await tx.query('select 1 from delivery limit 1');
      if (hasLoads.rows.length === 0)
        throw new Error('Run the operations scenario first (corepack pnpm db:scenario)');
      const rng = createRng(SEED);
      const trucks = (
        await tx.query<{ id: string; code: string; capacity_l: number }>(
          `select id, code, capacity_l from truck where status = 'active' order by code`,
        )
      ).rows;
      const drivers: DispatchDriver[] = [];
      for (const [i, name] of DRIVERS.slice(0, Math.max(2, trucks.length + 1)).entries()) {
        const code = `CH-${String(i + 1).padStart(2, '0')}`;
        const id = randomUUID();
        await tx.query(`insert into driver (id, code, name, created_by) values ($1, $2, $3, $4)`, [
          id,
          code,
          name,
          SYSTEM_ACTOR_ID,
        ]);
        drivers.push({ id, code, name });
      }
      for (const [category, days] of Object.entries(LEAD_DAYS)) {
        await tx.query(
          `update supplier set lead_time_days = $2 where category = $1 and lead_time_days is null`,
          [category, days],
        );
      }
      const { rotations, events } = await seedRotations(tx, today, rng, drivers, trucks);
      const plannedAhead = await seedPlannedAhead(tx, today, drivers, trucks);
      const counts = await seedCounts(tx, today, rng);
      const fuel = await seedFuel(tx, today, rng, trucks);
      const losses = await seedLosses(tx, today, rng);
      const gap = await seedGravelGap(tx, today);
      return {
        applied: true,
        drivers: drivers.length,
        rotations,
        events,
        plannedAhead,
        counts: counts + (gap ? 1 : 0),
        fills: fuel.fills,
        fuelPurchases: fuel.purchases,
        losses,
      };
    },
  );
}
