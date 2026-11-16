// T20 item 2: the sales history of the twin, 1 Sep to 15 Nov 2026. Orders go through the application's own order service (as the owner), loads and signed BLs through
// the same helpers the plant's own action and the pilot scenario use (so stock moves, BL numbers and the cost snapshot of every BL come from the real code), invoices
// through the invoice door. The injected numbering defects are listed in docs/TWIN-SEED.md.
import { randomUUID } from 'node:crypto';
import { parseKeyring } from '../../../src/lib/crypto/keyring.ts';
import { withRlsContext } from '../../../src/lib/db/rls-context.ts';
import {
  createOrder,
  insertCreditNoteRows,
  insertInvoiceRows,
  invoiceDueDate,
} from '../../../src/modules/ledger/index.ts';
import { nextDocNumber } from '../../../src/modules/ledger/service/doc-number.ts';
import { fieldCipherFrom } from '../../../src/modules/master-data/index.ts';
import {
  cancelUnproducedOrder,
  schedulePumpJob,
  setOrderPumped,
} from '../../../src/modules/operations/index.ts';
import { insertLoadRows, recetteInForce } from '../../../src/modules/operations/service/delivery-service.ts';
import { SYSTEM_ACTOR_ID, inRequest } from '../../../src/modules/platform-security/index.ts';
import type { SessionUser } from '../../../src/modules/platform-security/auth/session-gate.ts';
import { type TwinContext, addDays, daysBetween, must } from './context.ts';
import { type PlannedOrder, planSales } from './plan-sales.ts';
import type { World } from './structure.ts';

const system = { id: SYSTEM_ACTOR_ID } as SessionUser;

export interface SalesResult {
  plan: PlannedOrder[];
  orders: { plan: PlannedOrder; id: string; code: string }[];
  /** BL numbers taken from the series and never used: the injected "missing numbers" (D251). */
  burned: { plant: 'TET' | 'CHF'; month: string; blNo: string }[];
  loads: number;
  invoices: number;
}

export const TWIN_SALES_START = '2026-09-01';

/** How many numbers a plant-month loses: about 12 a month (D251); the part-month of November is scaled. */
const burnQuota = (month: string, anchor: string): number =>
  month === anchor.slice(0, 7) ? Math.round((12 * Number(anchor.slice(8))) / 30) : 12;

async function pumpOperators(ctx: TwinContext): Promise<string[]> {
  const ids: string[] = [];
  for (const name of ['Pompiste P-01 (fictif)', 'Pompiste P-02 (fictif)']) {
    const r = await inRequest(ctx.pools.app, ctx.owner, async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('driver:code', 0))`);
      const next = await tx.query<{ n: number }>(
        `select coalesce(max(substr(code, 4)::int), 0) + 1 as n from driver`,
      );
      const code = `CH-${String(next.rows[0]?.n ?? 1).padStart(2, '0')}`;
      return tx.query<{ id: string }>(
        `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, 'pump_operator') returning id`,
        [code, name, ctx.owner.id],
      );
    });
    ids.push(r.rows[0]!.id);
  }
  return ids;
}

export async function buildSales(ctx: TwinContext, world: World): Promise<SalesResult> {
  const { app, seed } = ctx.pools;
  const { owner, anchor } = ctx;
  const plan = planSales(ctx.rng, world.clients, { start: TWIN_SALES_START, anchor, futureDays: 2 });
  const cipher = fieldCipherFrom(parseKeyring(ctx.env.FIELD_ENCRYPTION_KEYS));
  const operators = await pumpOperators(ctx);

  // Orders (and their cancellations and pump jobs), in date order, through the services.
  const orders: SalesResult['orders'] = [];
  for (const p of plan) {
    const client = world.clients[p.clientIdx]!;
    const plantId = ctx.plants[p.plant].id;
    const created = must(
      `order ${p.n}`,
      await createOrder(
        app,
        owner,
        {
          clientId: client.id,
          plantId,
          concreteTypeId: world.types.get(p.typeCode)!,
          dischargeMethod: p.method,
          volumeL: p.volumeL,
          deliveryDate: p.deliveryDate,
          ...(p.clientPo ? { clientPo: p.clientPo } : {}),
          commercial: p.commercial,
          plan:
            p.preset === 'lcn'
              ? {
                  preset: 'custom',
                  items: [{ method: 'lcn', dueDate: addDays(p.deliveryDate, p.lcnDays), percentBp: 10_000 }],
                }
              : { preset: p.preset },
        },
        { today: p.orderDate },
      ),
    );
    orders.push({ plan: p, id: created.id, code: created.code });
    if (p.cancelReason) {
      must(
        `cancel ${p.n}`,
        await cancelUnproducedOrder(
          app,
          owner,
          { orderId: created.id, reason: p.cancelReason },
          { today: p.deliveryDate },
        ),
      );
    } else if (p.pump) {
      must(`pumped ${p.n}`, await setOrderPumped(app, owner, { orderId: created.id, pumped: true }));
      must(
        `pump job ${p.n}`,
        await schedulePumpJob(
          app,
          owner,
          {
            date: p.deliveryDate,
            pumpId: world.pumps[p.pump.pumpIdx]!.id,
            operatorId: operators[p.n % operators.length]!,
            orderId: created.id,
            onSiteMin: p.pump.onSiteMin,
            siteLabel: `Chantier ${client.code} (fictif)`,
            plannedM3: p.volumeL / 1000,
          },
          cipher,
        ),
      );
    }
  }

  // Loads, signed BLs, invoices: one system transaction (all or nothing), in business-date order across both plants so the BL series is one run.
  const burned: SalesResult['burned'] = [];
  let loads = 0;
  let invoices = 0;
  await withRlsContext(
    seed,
    { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: 'twin-seed-sales' },
    async (tx) => {
      const toLoad = orders
        .filter((o) => !o.plan.cancelReason && o.plan.deliveryDate <= anchor)
        .sort((a, b) => a.plan.deliveryDate.localeCompare(b.plan.deliveryDate) || a.plan.n - b.plan.n);
      // Which loads lose their number: chosen per plant-month up front, from the one generator.
      const perPlantMonth = new Map<string, number>();
      for (const o of toLoad) {
        const plantId = ctx.plants[o.plan.plant].id;
        const cap = world.mixers[o.plan.plant][0]!.capacityL;
        void plantId;
        const key = `${o.plan.plant}|${o.plan.deliveryDate.slice(0, 7)}`;
        perPlantMonth.set(key, (perPlantMonth.get(key) ?? 0) + Math.ceil(o.plan.volumeL / cap));
      }
      const burnAt = new Set<string>(); // `${plant}|${month}|${loadIndexInMonth}`
      for (const [key, total] of perPlantMonth) {
        const [plant, month] = key.split('|') as [string, string];
        const quota = Math.min(burnQuota(month, anchor), Math.floor(total / 3));
        const picked = new Set<number>();
        while (picked.size < quota) picked.add(ctx.rng.int(1, Math.max(1, total - 1)));
        for (const i of picked) burnAt.add(`${plant}|${month}|${i}`);
      }
      const lastDay = toLoad.reduce((m, o) => (o.plan.deliveryDate > m ? o.plan.deliveryDate : m), '');
      const seen = new Map<string, number>();
      const rotation = new Map<string, number>();
      const perDaySlot = new Map<string, number>();
      const lastLoad = new Map<string, string>();
      const allDelivered = new Map<string, boolean>();
      for (const o of toLoad) {
        const p = o.plan;
        const plantKey = `${p.plant}|${p.deliveryDate.slice(0, 7)}`;
        const trucks = world.mixers[p.plant];
        const recetteId = await recetteInForce(
          tx,
          world.types.get(p.typeCode)!,
          p.deliveryDate,
          ctx.plants[p.plant].id,
        );
        if (!recetteId)
          throw new Error(`twin seed: no recette in force for ${p.typeCode} on ${p.deliveryDate}`);
        let left = p.volumeL;
        allDelivered.set(o.id, true);
        while (left > 0) {
          const t = rotation.get(p.plant) ?? 0;
          rotation.set(p.plant, t + 1);
          const truck = trucks[t % trucks.length]!;
          const size = Math.min(left, truck.capacityL);
          left -= size;
          const idx = (seen.get(plantKey) ?? 0) + 1;
          seen.set(plantKey, idx);
          if (burnAt.has(`${plantKey}|${idx}`))
            burned.push({
              plant: p.plant,
              month: p.deliveryDate.slice(0, 7),
              blNo: await nextDocNumber(tx, 'BL', p.deliveryDate),
            });
          const dayKey = `${p.deliveryDate}|${p.plant}`;
          const slot = perDaySlot.get(dayKey) ?? 0;
          perDaySlot.set(dayKey, slot + 1);
          const minutes = 6 * 60 + 15 + ((slot * 29) % (10 * 60));
          const loadedAt = `${p.deliveryDate}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00Z`;
          const load = await insertLoadRows(tx, system, {
            orderId: o.id,
            truckId: truck.id,
            volumeL: size,
            date: p.deliveryDate,
            recetteId,
            loadedAt,
          });
          loads += 1;
          // Delivered 100 minutes after leaving, except the later loads of the last working day (still on the road).
          const onTheRoad = p.deliveryDate === lastDay && slot >= 5;
          if (onTheRoad) allDelivered.set(o.id, false);
          else
            await tx.query(
              `insert into delivery_delivered (id, delivery_id, at, trip_event_id, created_by, via) values ($1, $2, $3::timestamptz + interval '100 minutes', null, $4, 'hand')`,
              [randomUUID(), load.id, loadedAt, SYSTEM_ACTOR_ID],
            );
          // The signed BL comes back within a day or two for most loads older than two days; a few bring back concrete.
          if (p.deliveryDate <= addDays(anchor, -2) && ctx.rng.next() < 0.93) {
            await tx.query(
              `insert into delivery_return (id, delivery_id, returned_on, returned_volume_l, created_by) values ($1, $2, $3, $4, $5)`,
              [
                randomUUID(),
                load.id,
                addDays(p.deliveryDate, ctx.rng.int(0, 1)),
                ctx.rng.next() < 0.05 ? ctx.rng.int(1, 8) * 100 : 0,
                SYSTEM_ACTOR_ID,
              ],
            );
          }
        }
        lastLoad.set(o.id, p.deliveryDate);
      }

      // Invoices: an order fully delivered, three days after its last load at the latest; most are invoiced within days, a few late, a few left in the queue.
      const invoiced: string[] = [];
      for (const o of toLoad) {
        if (!allDelivered.get(o.id)) continue;
        if (daysBetween(o.plan.deliveryDate, anchor) < 3) continue;
        if (ctx.rng.next() < 0.06) continue;
        const date = addDays(o.plan.deliveryDate, ctx.rng.int(0, 5) + (ctx.rng.next() < 0.08 ? 20 : 0));
        const invoiceDate = date > anchor ? anchor : date;
        const due = invoiceDueDate(invoiceDate, null);
        if (!due.ok) throw new Error(due.error);
        const r = await insertInvoiceRows(tx, system, { orderCode: o.code }, due.value, invoiceDate);
        if (!r.ok) throw new Error(`twin seed: invoice refused (${r.error}) for ${o.code}`);
        invoiced.push(r.value.id);
        invoices += 1;
      }
      for (const [k, id] of [
        [3, invoiced[3]],
        [40, invoiced[40]],
      ] as const) {
        if (!id) continue;
        const r = await insertCreditNoteRows(
          tx,
          system,
          id,
          k === 3 ? 'Erreur de prix, facture annulée (fictif)' : 'Livraison refusée, avoir total (fictif)',
          addDays(anchor, -k / 4),
        );
        if (!r.ok) throw new Error(`twin seed: credit note refused (${r.error})`);
      }
    },
  );
  return { plan, orders, burned, loads, invoices };
}
