// The working day of the training instance (T5). Everything is dated from the business day it is given ("today"), so the trainees
// always find work to do: orders to dispatch, rotations in sequence for the three phone drivers, quotes to turn into orders, an order
// to cancel, a delivery to receive, a low-stock alert. It is used by the seed (once, at the end) and by `rearm:training` (any morning).
// Fictitious data only, written through the application's own services as the training accounts' roles: the same rules, row-level
// security and audit as a screen entry. Not an entry point.
import pg from 'pg';
import { createOrder, createPurchase, createQuote } from '../src/modules/ledger/index.ts';
import {
  cancelUnproducedOrder,
  saveDispatch,
  setStockThreshold,
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
}
export interface ArmedDay {
  date: string;
  ordersCreated: number;
  ordersCancelled: number;
  rotationsPlanned: number;
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
              volumeL: volumes[i],
              deliveryDate: today,
              plan: { preset: plan[i] },
            },
            { today },
          ),
        ),
      );
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
    return { date: today, ordersCreated: 6, ordersCancelled: cancelled, rotationsPlanned: saved.rotations };
  } finally {
    await Promise.all([app.end(), migrator.end()]);
  }
}
