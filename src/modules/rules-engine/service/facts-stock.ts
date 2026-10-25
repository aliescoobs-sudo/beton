import type pg from 'pg';
import { centimes } from '@/lib/money';
import { addDaysIso } from '@/modules/ledger';
import { getStockLevels } from '@/modules/operations';
import { can, inRequest, require, type SessionUser } from '@/modules/platform-security';
import type { RecetteVersion, StockFacts, SupplierHint } from '../domain';

/**
 * The stock facts (levels, what the open orders still need, the recette in force, the receipts expected): quantities only,
 * read from the non-money views, so the plant and the partner can have the stock risk (DECISIONS 81). The preferred
 * supplier and its last price are money: only for roles that read them (owner, support).
 */
export async function loadStockFacts(
  appPool: pg.Pool,
  actor: SessionUser,
  today: string,
  opts: { horizonDays: number; purchaseLeadDays: number },
): Promise<StockFacts> {
  await require(appPool, actor, 'stock.read');
  const levels = await getStockLevels(appPool, actor);
  // Orders further away than the horizon (even over Sundays and holidays) cannot reach it.
  const until = addDaysIso(today, opts.horizonDays * 2 + 7);

  const rows = await inRequest(appPool, actor, async (tx) => {
    const demands = await tx.query<{
      id: string;
      code: string;
      client_code: string;
      type_id: string;
      type_label: string;
      date: string;
      remaining: string;
    }>(
      `select o.id, o.code, o.client_code, o.concrete_type_id as type_id, t.label as type_label,
              to_char(o.delivery_date, 'YYYY-MM-DD') as date,
              (o.volume_l - coalesce((select sum(d.volume_l) from delivery d where d.order_id = o.id), 0))::text as remaining
         from sales_order_ops o join concrete_type t on t.id = o.concrete_type_id
        where o.reverses_id is null and not o.is_reversed and o.delivery_date <= $1`,
      [until],
    );
    const recettes = await tx.query<{ type_id: string; from: string; component_id: string; qty: string }>(
      `select r.concrete_type_id as type_id, to_char(r.effective_from, 'YYYY-MM-DD') as from, l.component_id::text, l.qty_per_m3::text as qty
         from recette r join recette_line l on l.recette_id = r.id`,
    );
    const receipts = await tx.query<{
      id: string;
      code: string;
      order_date: string;
      component_id: string;
      qty_base: string;
    }>(
      `select l.purchase_id as id, l.code, to_char(l.order_date, 'YYYY-MM-DD') as order_date, l.component_id::text,
              floor(greatest(0, l.qty_milli - coalesce((select sum(x.qty_milli) from purchase_receipt_line x where x.purchase_line_id = l.line_id), 0))::numeric * l.factor_to_base / 1000)::text as qty_base
         from purchase_line_ops l
        where not l.is_reversed`,
    );
    return {
      demands: demands.rows,
      recettes: recettes.rows,
      receipts: receipts.rows.filter((r) => Number(r.qty_base) > 0),
    };
  });

  const recettes = new Map<string, RecetteVersion[]>();
  const byVersion = new Map<string, RecetteVersion>();
  for (const r of rows.recettes) {
    const key = `${r.type_id}|${r.from}`;
    let version = byVersion.get(key);
    if (!version) {
      version = { effectiveFrom: r.from, lines: [] };
      byVersion.set(key, version);
      recettes.set(r.type_id, [...(recettes.get(r.type_id) ?? []), version]);
    }
    version.lines.push({ componentId: r.component_id, qtyPerM3: Number(r.qty) });
  }

  return {
    components: levels.map((l) => ({
      id: l.componentId,
      nameFr: l.nameFr,
      nameAr: l.nameAr,
      baseUnit: l.baseUnit,
      level: l.level,
      lowThreshold: l.lowThreshold,
    })),
    demands: rows.demands
      .filter((d) => Number(d.remaining) > 0)
      .map((d) => ({
        orderId: d.id,
        orderCode: d.code,
        clientCode: d.client_code,
        typeId: d.type_id,
        typeLabel: d.type_label,
        date: d.date,
        volumeL: Number(d.remaining),
      })),
    recettes,
    receipts: rows.receipts.map((r) => {
      const expected = addDaysIso(r.order_date, opts.purchaseLeadDays);
      return {
        purchaseId: r.id,
        purchaseCode: r.code,
        componentId: r.component_id,
        qtyBase: Number(r.qty_base),
        date: expected < today ? today : expected,
      };
    }),
    suppliers: can(actor.role, 'purchase_prices.read') ? await loadSupplierHints(appPool, actor) : new Map(),
  };
}

/** The last supplier of each component, its purchase unit, last price and terms (owner and support only). */
async function loadSupplierHints(appPool: pg.Pool, actor: SessionUser): Promise<Map<string, SupplierHint>> {
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      component_id: string;
      supplier_id: string;
      code: string;
      name: string;
      unit_id: string;
      unit: string;
      factor: string;
      price: string;
      term: number;
      lead_time_days: number | null;
    }>(
      `select distinct on (l.component_id) l.component_id::text, s.id::text as supplier_id, s.code, s.name,
              u.id::text as unit_id, u.label as unit, u.factor_to_base::text as factor,
              l.unit_price_ht_centimes::text as price, (p.due_date - p.order_date) as term, s.lead_time_days
         from purchase_line l
         join purchase p on p.id = l.purchase_id
         join supplier s on s.id = p.supplier_id
         join purchase_unit u on u.id = l.purchase_unit_id
        where l.component_id is not null and p.reverses_id is null
          and not exists (select 1 from purchase r where r.reverses_id = p.id)
        order by l.component_id, p.order_date desc, p.created_at desc`,
    ),
  );
  return new Map(
    rows.map((r) => [
      r.component_id,
      {
        supplierId: r.supplier_id,
        supplierCode: r.code,
        supplierName: r.name,
        purchaseUnitId: r.unit_id,
        unitLabel: r.unit,
        factorToBase: Number(r.factor),
        lastUnitPriceHt: centimes(Number(r.price)),
        termDays: r.term,
        leadTimeDays: r.lead_time_days,
      },
    ]),
  );
}
