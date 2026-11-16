// T20 item 4: stock, receipts, fuel and counts. The consumption is NOT written here: it is what the stock engine wrote from the BLs (item 2). This step opens the stock,
// buys what keeps every component above zero (purchases through the purchase service, arrival confirmed by the plant manager, receipt recorded by the owner), sets the
// thresholds, records the fuel (tank opening, fills per truck against the per-trip norm, purchases) with one truck-month that burns far more than the norm says, and
// ends with a count round by each plant manager (small variances inside the tolerance post, two outside wait for a decision).
import { createPurchase } from '../../../src/modules/ledger/index.ts';
import { listPurchasePrices } from '../../../src/modules/master-data/index.ts';
import {
  confirmArrivalAtPlant,
  recordFuelFill,
  recordFuelPurchase,
  recordReceipt,
  setFuelTankOpening,
  setOpeningStock,
  setStockThreshold,
} from '../../../src/modules/operations/index.ts';
import { inRequest } from '../../../src/modules/platform-security/index.ts';
import { type TwinContext, addDays, isWorkingDay, must } from './context.ts';
import { planReceipts } from './plan-stock.ts';
import type { World } from './structure.ts';

export const TWIN_STOCK_OPENING_DATE = '2026-08-31';

interface ComponentRule {
  name: string;
  /** Smallest quantity of a purchase in base units (a tonne of g, a m³ of L, a litre of mL). */
  unit: number;
  purchaseUnit: string;
  category: 'cement' | 'aggregates' | 'admixture' | 'other';
  countCategory: 'moisture' | 'loss' | 'returned_load' | 'error' | 'theft_suspicion' | 'other';
}
const RULES: ComponentRule[] = [
  { name: 'Ciment', unit: 1_000_000, purchaseUnit: 't', category: 'cement', countCategory: 'loss' },
  { name: 'Sable', unit: 1_000_000, purchaseUnit: 't', category: 'aggregates', countCategory: 'moisture' },
  {
    name: 'Gravette 8/15',
    unit: 1_000_000,
    purchaseUnit: 't',
    category: 'aggregates',
    countCategory: 'error',
  },
  {
    name: 'Gravette 15/25',
    unit: 1_000_000,
    purchaseUnit: 't',
    category: 'aggregates',
    countCategory: 'error',
  },
  { name: 'Eau', unit: 1_000, purchaseUnit: 'm³', category: 'other', countCategory: 'other' },
  { name: 'Adjuvant', unit: 1_000, purchaseUnit: 'L', category: 'admixture', countCategory: 'loss' },
];

export interface StockResult {
  purchases: number;
  receipts: number;
  onTheWay: number;
  fills: number;
  fuelPurchases: number;
  counts: { posted: number; pending: number };
}

const mad = (centimes: number): string =>
  `${Math.floor(centimes / 100)},${String(centimes % 100).padStart(2, '0')}`;

export async function buildStock(ctx: TwinContext, world: World): Promise<StockResult> {
  const { app, migrator } = ctx.pools;
  const { owner, anchor, rng } = ctx;
  const out: StockResult = {
    purchases: 0,
    receipts: 0,
    onTheWay: 0,
    fills: 0,
    fuelPurchases: 0,
    counts: { posted: 0, pending: 0 },
  };

  const supplierBy = (pred: (s: World['suppliers'][number]) => boolean) => world.suppliers.filter(pred);
  const cementSuppliers = supplierBy((s) => s.category === 'cement');
  const aggregateSuppliers = supplierBy((s) => s.category === 'aggregates');
  const admixSuppliers = supplierBy((s) => s.category === 'admixture');
  const waterSupplier = supplierBy((s) => s.name.startsWith('Régie'))[0]!;
  const unitIds = new Map(
    (
      await migrator.query<{ id: string; component_id: string; label: string }>(
        'select id, component_id, label from purchase_unit',
      )
    ).rows.map((u) => [`${u.component_id}|${u.label}`, u.id]),
  );

  // Consumption per plant, component and day, as the BLs wrote it.
  const used = (
    await migrator.query<{ plant: string; component_id: string; d: string; q: string }>(
      `select p.code as plant, m.component_id, to_char(m.movement_date, 'YYYY-MM-DD') as d, (-sum(m.qty_base))::text as q
         from stock_movement m join plant p on p.id = m.plant_id where m.source = 'delivery' group by 1, 2, 3`,
    )
  ).rows;

  interface Buy {
    plant: 'TET' | 'CHF';
    rule: ComponentRule;
    componentId: string;
    orderDate: string;
    receiptDate: string;
    qty: number;
  }
  const buys: Buy[] = [];
  for (const plant of ['TET', 'CHF'] as const) {
    const code = plant === 'TET' ? 'TETOUAN' : 'CHEFCHN';
    for (const rule of RULES) {
      const componentId = world.components.get(rule.name)!.id;
      const consumption = new Map(
        used.filter((u) => u.plant === code && u.component_id === componentId).map((u) => [u.d, Number(u.q)]),
      );
      const plan = planReceipts(
        {
          start: '2026-09-01',
          end: anchor,
          consumption,
          unit: rule.unit,
          reorderDays: 5,
          lotDays: 9,
          leadDays: 2,
        },
        rng,
      );
      must(
        `opening ${plant} ${rule.name}`,
        await setOpeningStock(app, owner, {
          componentId,
          date: TWIN_STOCK_OPENING_DATE,
          qtyBase: plan.opening,
          plantId: ctx.plants[plant].id,
        }),
      );
      let total = 0;
      for (const v of consumption.values()) total += v;
      const avg = total / 76;
      must(
        `threshold ${plant} ${rule.name}`,
        await setStockThreshold(app, owner, {
          componentId,
          lowQtyBase: Math.max(rule.unit, Math.round((avg * 3) / rule.unit) * rule.unit),
          plantId: ctx.plants[plant].id,
        }),
      );
      for (const r of plan.receipts)
        buys.push({
          plant,
          rule,
          componentId,
          orderDate: r.orderDate,
          receiptDate: r.receiptDate,
          qty: r.qty,
        });
    }
  }
  buys.sort(
    (a, b) =>
      a.orderDate.localeCompare(b.orderDate) ||
      a.plant.localeCompare(b.plant) ||
      a.rule.name.localeCompare(b.rule.name),
  );

  // Prices in force on the order date (the price list the master data holds, with the October cement rise), a second supplier a little dearer.
  const prices = new Map<string, Awaited<ReturnType<typeof listPurchasePrices>>>();
  for (const rule of RULES)
    prices.set(rule.name, await listPurchasePrices(app, owner, world.components.get(rule.name)!.id));
  const priceAt = (name: string, date: string) => prices.get(name)!.find((p) => p.effectiveFrom <= date)!;

  const partial = new Set([7, 31, 58]); // three arrivals are counted short: part of the load refused at the gate
  for (const [k, b] of buys.entries()) {
    const price = priceAt(b.rule.name, b.orderDate);
    const alt = k % 5 === 4;
    const suppliers =
      b.rule.category === 'cement'
        ? cementSuppliers
        : b.rule.category === 'aggregates'
          ? aggregateSuppliers
          : b.rule.category === 'admixture'
            ? admixSuppliers
            : [waterSupplier];
    const supplier =
      b.rule.category === 'other'
        ? waterSupplier
        : b.rule.category === 'cement'
          ? (alt
              ? cementSuppliers.find((s) => s.name.startsWith('Ciments Atlas'))
              : cementSuppliers.find((s) => s.name.startsWith('Ciments du Nord')))!
          : b.rule.category === 'aggregates'
            ? aggregateSuppliers.find((s) =>
                b.plant === 'CHF'
                  ? s.name.startsWith('Granulats Chefchaouen') ||
                    (b.rule.name === 'Sable' && s.name.startsWith('Sablière'))
                  : s.name.startsWith('Carrière'),
              )!
            : admixSuppliers[k % admixSuppliers.length]!;
    void suppliers;
    const unitPrice = Math.round(
      price.priceHtCentimes * (alt || supplier.name.startsWith('Chimie') ? 1.02 : 1),
    );
    const terms = b.rule.category === 'cement' ? 60 : 30;
    const created = must(
      `purchase ${k}`,
      await createPurchase(
        app,
        owner,
        {
          supplierId: supplier.id,
          plantId: ctx.plants[b.plant].id,
          supplierInvoiceNo: `F-${b.orderDate.slice(2, 4)}${b.orderDate.slice(5, 7)}-${String(100 + k)}`,
          supplierInvoiceDate: b.orderDate,
          payable: 'order',
          lines: [
            {
              componentId: b.componentId,
              purchaseUnitId: unitIds.get(`${b.componentId}|${b.rule.purchaseUnit}`)!,
              qtyMilli: Math.round((b.qty / b.rule.unit) * 1000),
              unitPriceHtCentimes: unitPrice,
            },
          ],
          plan: [
            {
              method: b.rule.category === 'cement' ? 'lcn' : k % 3 === 0 ? 'transfer' : 'cheque',
              dueDate: addDays(b.orderDate, terms),
              percentBp: 10_000,
            },
          ],
        },
        { today: b.orderDate },
      ),
    );
    out.purchases += 1;
    if (b.receiptDate > anchor) {
      out.onTheWay += 1;
      continue;
    }
    const line = (
      await inRequest(app, owner, (tx) =>
        tx.query<{ line_id: string; qty_milli: string }>(
          'select line_id, qty_milli::text from purchase_line_ops where purchase_id = $1 limit 1',
          [created.id],
        ),
      )
    ).rows[0]!;
    const ordered = Number(line.qty_milli);
    if (partial.has(k) && ordered >= 10_000) {
      const refused = Math.round(ordered * 0.04);
      must(
        `arrival ${k}`,
        await confirmArrivalAtPlant(app, ctx.plantManagers[b.plant], {
          purchaseId: created.id,
          note: 'Une partie refusée à la porte (fictif)',
          lines: [{ lineId: line.line_id, arrivedMilli: ordered, rejectedMilli: refused, available: true }],
        }),
      );
      must(
        `receipt ${k}`,
        await recordReceipt(
          app,
          owner,
          {
            purchaseId: created.id,
            receivedDate: b.receiptDate,
            lines: [{ lineId: line.line_id, qtyMilli: ordered - refused }],
          },
          { today: b.receiptDate },
        ),
      );
    } else {
      must(
        `arrival ${k}`,
        await confirmArrivalAtPlant(app, ctx.plantManagers[b.plant], { purchaseId: created.id }),
      );
      must(
        `receipt ${k}`,
        await recordReceipt(
          app,
          owner,
          { purchaseId: created.id, receivedDate: b.receiptDate },
          { today: b.receiptDate },
        ),
      );
    }
    out.receipts += 1;
  }

  // Services bought (transport of aggregates, spare parts): payables with no stock effect, each plant, every month.
  const transport = world.suppliers.find(
    (s) => s.category === 'transport' && s.name.startsWith('Transports'),
  )!;
  const parts = world.suppliers.find((s) => s.name.startsWith('Pièces'))!;
  for (const plant of ['TET', 'CHF'] as const)
    for (const month of ['2026-09', '2026-10', '2026-11'])
      for (const [supplier, label, low, high] of [
        [transport, 'Transport de granulats (fictif)', 2_500_000, 6_000_000],
        [parts, 'Pièces et entretien mixers (fictif)', 300_000, 1_500_000],
      ] as const) {
        const date = `${month}-${plant === 'TET' ? '10' : '12'}`;
        if (date > anchor) continue;
        must(
          `service ${label}`,
          await createPurchase(
            app,
            owner,
            {
              supplierId: supplier.id,
              plantId: ctx.plants[plant].id,
              supplierInvoiceNo: `S-${date.slice(2, 4)}${date.slice(5, 7)}-${plant}-${supplier.category.slice(0, 2)}`,
              supplierInvoiceDate: date,
              payable: 'order',
              lines: [{ description: label, qtyMilli: 1000, unitPriceHtCentimes: rng.int(low, high) }],
              plan: [{ method: 'cheque', dueDate: addDays(date, 30), percentBp: 10_000 }],
            },
            { today: date },
          ),
        );
        out.purchases += 1;
      }

  await buildFuel(ctx, world, out);
  await buildCounts(ctx, world, out);
  return out;
}

async function buildFuel(ctx: TwinContext, world: World, out: StockResult): Promise<void> {
  const { app, migrator } = ctx.pools;
  const { owner, anchor, rng } = ctx;
  for (const plant of ['TET', 'CHF'] as const)
    must(
      `fuel tank ${plant}`,
      await setFuelTankOpening(app, owner, {
        plantId: ctx.plants[plant].id,
        litres: 6000,
        asOf: TWIN_STOCK_OPENING_DATE,
      }),
    );

  // What the per-trip norm says each mixer burns per month, from the cost snapshots of its BLs.
  const expected = (
    await migrator.query<{ truck_id: string; plant: string; month: string; ml: string }>(
      `select d.truck_id, p.code as plant, to_char(d.load_date, 'YYYY-MM') as month, sum(s.trip_fuel_ml)::text as ml
         from bl_cost_snapshot s join delivery d on d.id = s.delivery_id join truck t on t.id = d.truck_id join plant p on p.id = t.plant_id
        where s.reverses_id is null and s.trip_fuel_ml is not null group by 1, 2, 3 order by 1, 3`,
    )
  ).rows;
  const trucks = [...world.mixers.TET, ...world.mixers.CHF];
  const flagged = { truck: world.mixers.TET[1]!.id, month: '2026-10' }; // T2 in October burns about a third more than the norm
  const odometer = new Map(trucks.map((t, i) => [t.id, 41_000 + i * 3_700]));
  const perPlantMonth = new Map<string, number>();
  for (const e of expected) {
    const truck = trucks.find((t) => t.id === e.truck_id);
    if (!truck) continue;
    const factor = e.truck_id === flagged.truck && e.month === flagged.month ? 1.32 : 0.95 + rng.next() * 0.1;
    const measuredMl = Math.round(Number(e.ml) * factor);
    const n = Math.max(2, Math.ceil(measuredMl / 190_000));
    const monthEnd =
      e.month === anchor.slice(0, 7)
        ? anchor
        : addDays(`${e.month}-01`, 30).slice(0, 7) === e.month
          ? `${e.month}-30`
          : `${e.month}-28`;
    const days: string[] = [];
    for (let d = `${e.month}-02`; d <= monthEnd; d = addDays(d, 1)) if (isWorkingDay(d)) days.push(d);
    let left = measuredMl;
    for (let i = 0; i < n; i++) {
      const ml = i === n - 1 ? left : Math.round(measuredMl / n);
      left -= ml;
      const date = days[Math.min(days.length - 1, Math.floor(((i + 0.5) * days.length) / n))]!;
      const km = odometer.get(truck.id)! + Math.max(1, Math.round((ml / 1000) * 3.2));
      odometer.set(truck.id, km);
      must(
        `fill ${truck.code}`,
        await recordFuelFill(app, owner, {
          truckId: truck.id,
          filledOn: date,
          litres: String(Math.max(1, Math.round(ml / 1000))),
          odometerKm: km,
          source: 'tank',
        }),
      );
      out.fills += 1;
      perPlantMonth.set(
        `${e.plant}|${e.month}`,
        (perPlantMonth.get(`${e.plant}|${e.month}`) ?? 0) + Math.round(ml / 1000),
      );
    }
  }
  // Fuel bought for the tanks: each plant buys for the month it is in, four per cent above what its trucks took, at about 17 MAD a litre.
  const station = (plant: 'TET' | 'CHF') =>
    world.suppliers.find(
      (s) =>
        s.category === 'fuel' &&
        (plant === 'TET' ? s.name.startsWith('Station Martil') : s.name.startsWith('Station Chefchaouen')),
    )!;
  for (const [key, litres] of [...perPlantMonth].sort()) {
    const [code, month] = key.split('|') as [string, string];
    const plant = code === 'TETOUAN' ? 'TET' : 'CHF';
    const bought = Math.round((litres * 1.04) / 100) * 100 + 500;
    must(
      `fuel purchase ${key}`,
      await recordFuelPurchase(
        app,
        { ...owner, plantId: ctx.plants[plant].id },
        {
          purchasedOn: `${month}-01` < '2026-09-02' ? '2026-09-02' : `${month}-01`,
          litres: String(bought),
          totalMad: mad(Math.round(bought * 1700 * (1 + (rng.next() - 0.5) * 0.03))),
          supplierId: station(plant).id,
        },
      ),
    );
    out.fuelPurchases += 1;
  }
  void inRequest;
}

async function buildCounts(ctx: TwinContext, world: World, out: StockResult): Promise<void> {
  const { app, migrator } = ctx.pools;
  const { rng } = ctx;
  for (const plant of ['TET', 'CHF'] as const) {
    const manager = ctx.plantManagers[plant];
    for (const rule of RULES) {
      const componentId = world.components.get(rule.name)!.id;
      const theo = Number(
        (
          await migrator.query<{ q: string }>(
            'select coalesce(sum(qty_base), 0)::text as q from stock_movement where component_id = $1 and plant_id = $2',
            [componentId, ctx.plants[plant].id],
          )
        ).rows[0]!.q,
      );
      // Small variances inside the 2 % tolerance post by themselves; the admixture has no tolerance, so only the exact count posts; two counts are off by more and wait.
      const outside =
        (plant === 'TET' && rule.name === 'Sable') || (plant === 'CHF' && rule.name === 'Adjuvant');
      const delta = outside
        ? plant === 'TET'
          ? -0.045
          : 0.03
        : rule.name === 'Adjuvant'
          ? 0
          : (rng.next() - 0.55) * 0.03;
      const counted = Math.max(0, Math.round(theo * (1 + delta)));
      const r = await inRequest(app, manager, (tx) =>
        tx.query<{ o_status: string }>('select o_status from public.propose_stock_count($1, $2, $3, $4)', [
          componentId,
          counted,
          outside && rule.name === 'Sable' ? 'theft_suspicion' : rule.countCategory,
          outside ? 'Écart constaté au comptage de mi-novembre (fictif)' : 'Comptage de mi-novembre (fictif)',
        ]),
      );
      if (r.rows[0]?.o_status === 'pending_decision') out.counts.pending += 1;
      else out.counts.posted += 1;
    }
  }
}
