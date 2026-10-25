import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { isRealDate } from '@/modules/ledger';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';
import {
  consumptionReport,
  lostComponents,
  type LostComponentRow,
  type ConsumptionRow,
  type LoadFact,
  type MovementFact,
  type MovementSource,
  type ProducedRow,
  producedByType,
  type ReportPeriod,
} from '../domain/consumption-report';
import { consumptionForLoad } from '../domain/consumption';
import { opsParameter } from './ops-parameters';

export interface ConsumptionComponent {
  id: string;
  nameFr: string;
  nameAr: string;
  baseUnit: string;
}

export interface ConsumptionReportView {
  from: string;
  to: string;
  period: ReportPeriod;
  toleranceBp: number;
  /** m³ produced per concrete type and period (litres). */
  produced: ProducedRow[];
  components: ConsumptionComponent[];
  consumption: ConsumptionRow[];
  /** Concrete lost (rejected or brought back), already part of the production and the theoretical consumption: its own lines. */
  loss: {
    /** Litres lost per concrete type and period. */
    produced: ProducedRow[];
    /** The components that lost concrete used, per period (base units). */
    components: LostComponentRow[];
  };
}

const MAX_DAYS = 400;
const PERIODS: readonly ReportPeriod[] = ['day', 'week', 'month'];

/**
 * Production and consumption over [from, to] (AC-OPS-18, 19): litres produced per type, theoretical consumption per
 * component (the movements written at each load) against the physical-count adjustments, flagged above the tolerance. A
 * cancellation counts on the date of what it cancels. Quantities only, so the plant and the partner read it.
 */
export async function getConsumptionReport(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { from: string; to: string; period: ReportPeriod },
): Promise<Result<ConsumptionReportView, 'INVALID'>> {
  await require(appPool, actor, 'reports.consumption');
  const { from, to, period } = input;
  if (!isRealDate(from) || !isRealDate(to) || to < from || !PERIODS.includes(period)) return err('INVALID');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_DAYS) return err('INVALID');
  return ok(
    await inRequest(appPool, actor, async (tx) => {
      const toleranceBp = await opsParameter(tx, 'consumption_tolerance_bp');
      const loads = await tx.query<{ date: string; type_id: string; type_label: string; volume_l: number }>(
        `select to_char(coalesce(orig.load_date, d.load_date), 'YYYY-MM-DD') as date, t.id as type_id, t.label as type_label,
                d.volume_l
           from delivery d
           left join delivery orig on orig.id = d.reverses_id
           join sales_order_ops o on o.id = d.order_id
           join concrete_type t on t.id = o.concrete_type_id
          where coalesce(orig.load_date, d.load_date) between $1 and $2`,
        [from, to],
      );
      const moves = await tx.query<{
        component_id: string;
        date: string;
        qty_base: string;
        source: MovementSource;
      }>(
        `select m.component_id, to_char(coalesce(orig.movement_date, m.movement_date), 'YYYY-MM-DD') as date,
                m.qty_base::text, m.source
           from stock_movement m
           left join stock_movement orig on orig.id = m.reverses_id
          where m.source in ('delivery', 'reversal', 'count_adjustment')
            and coalesce(orig.movement_date, m.movement_date) between $1 and $2`,
        [from, to],
      );
      // Losses of live loads, on the date of the load: litres per type, and the components that volume consumed (the recette
      // stored on the load times the lost litres).
      const losses = await tx.query<{
        date: string;
        type_id: string;
        type_label: string;
        volume_l: number;
        recette_id: string;
      }>(
        `select to_char(d.load_date, 'YYYY-MM-DD') as date, t.id as type_id, t.label as type_label, x.volume_l, d.recette_id
           from delivery_loss x
           join delivery d on d.id = x.delivery_id and d.reverses_id is null
           join sales_order_ops o on o.id = d.order_id
           join concrete_type t on t.id = o.concrete_type_id
          where d.load_date between $1 and $2
            and not exists (select 1 from delivery c where c.reverses_id = d.id)`,
        [from, to],
      );
      const lostFacts: { date: string; componentId: string; qtyBase: number }[] = [];
      for (const l of losses.rows) {
        const lines = await tx.query<{ component_id: string; qty_per_m3: string }>(
          `select component_id, qty_per_m3::text from recette_line where recette_id = $1`,
          [l.recette_id],
        );
        for (const q of consumptionForLoad(
          lines.rows.map((r) => ({ componentId: r.component_id, qtyPerM3: Number(r.qty_per_m3) })),
          l.volume_l,
        ))
          lostFacts.push({ date: l.date, componentId: q.componentId, qtyBase: q.qtyBase });
      }
      const components = await tx.query<{ id: string; name_fr: string; name_ar: string; base_unit: string }>(
        `select c.id, c.name_fr, c.name_ar, c.base_unit from component c order by c.name_fr`,
      );
      const loadFacts: LoadFact[] = loads.rows.map((r) => ({
        date: r.date,
        typeId: r.type_id,
        typeLabel: r.type_label,
        volumeL: r.volume_l,
      }));
      const moveFacts: MovementFact[] = moves.rows.map((r) => ({
        componentId: r.component_id,
        date: r.date,
        qtyBase: Number(r.qty_base),
        source: r.source,
      }));
      return {
        from,
        to,
        period,
        toleranceBp,
        produced: producedByType(loadFacts, period),
        components: components.rows.map((c) => ({
          id: c.id,
          nameFr: c.name_fr,
          nameAr: c.name_ar,
          baseUnit: c.base_unit,
        })),
        consumption: consumptionReport(moveFacts, period, toleranceBp),
        loss: {
          produced: producedByType(
            losses.rows.map((l) => ({
              date: l.date,
              typeId: l.type_id,
              typeLabel: l.type_label,
              volumeL: l.volume_l,
            })),
            period,
          ),
          components: lostComponents(lostFacts, period),
        },
      };
    }),
  );
}
