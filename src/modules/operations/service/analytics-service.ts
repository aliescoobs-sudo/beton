import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { centimes } from '@/lib/money';
import { isRealDate } from '@/modules/ledger';
import { can, inRequest, require, type SessionUser } from '@/modules/platform-security';
import type { ReportPeriod } from '../domain/consumption-report';
import {
  amountBy,
  type AmountRow,
  type Dimension,
  type PricedLoad,
  type SoldLoad,
  volumeBy,
  type VolumeRow,
} from '../domain/volume-analytics';

const PERIODS: readonly ReportPeriod[] = ['day', 'week', 'month'];
const DIMENSIONS: readonly Dimension[] = ['client', 'type', 'zone'];
const MAX_DAYS = 800;

export interface VolumeAnalytics {
  from: string;
  to: string;
  period: ReportPeriod;
  dimension: Dimension;
  /** Litres per period and dimension, from the live loads. No money field. */
  volume: VolumeRow[];
  /** Owner and support only: the same rows with the amount (HT, at the order's price). The key does not exist for others. */
  amounts?: AmountRow[];
}

/**
 * m³ delivered per day, week or month, per client, concrete type or zone (AC-OPS-24). The owner, the partner and support
 * read the quantities; the amounts are computed apart and returned to the owner and support only, so the partner's answer
 * has no amount field at all. A cancellation counts on the date of the load it cancels.
 */
export async function getVolumeAnalytics(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { from: string; to: string; period: ReportPeriod; dimension: Dimension; plantId?: string | null },
): Promise<Result<VolumeAnalytics, 'INVALID'>> {
  await require(appPool, actor, 'analytics.read');
  const { from, to, period, dimension } = input;
  if (!isRealDate(from) || !isRealDate(to) || to < from) return err('INVALID');
  if (!PERIODS.includes(period) || !DIMENSIONS.includes(dimension)) return err('INVALID');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_DAYS) return err('INVALID');
  const withMoney = can(actor.role, 'analytics.money');
  return ok(
    await inRequest(appPool, actor, async (tx) => {
      const { rows } = await tx.query<{
        date: string;
        order_id: string;
        client_code: string;
        type_id: string;
        type_label: string;
        zone_id: string | null;
        zone_name: string | null;
        volume_l: number;
      }>(
        `select to_char(coalesce(orig.load_date, d.load_date), 'YYYY-MM-DD') as date, o.id as order_id, o.client_code,
                t.id as type_id, t.label as type_label, o.zone_id, z.name as zone_name, d.volume_l
           from delivery d
           left join delivery orig on orig.id = d.reverses_id
           join sales_order_ops o on o.id = d.order_id
           join concrete_type t on t.id = o.concrete_type_id
           left join zone z on z.id = o.zone_id
          where coalesce(orig.load_date, d.load_date) between $1 and $2 and ($3::uuid is null or d.plant_id = $3)`,
        [from, to, input.plantId ?? null],
      );
      const sold = rows.map((r) => ({
        orderId: r.order_id,
        load: {
          date: r.date,
          clientId: r.client_code,
          clientCode: r.client_code,
          typeId: r.type_id,
          typeLabel: r.type_label,
          zoneId: r.zone_id,
          zoneName: r.zone_name,
          volumeL: r.volume_l,
        } satisfies SoldLoad,
      }));
      const result: VolumeAnalytics = {
        from,
        to,
        period,
        dimension,
        volume: volumeBy(
          sold.map((s) => s.load),
          period,
          dimension,
        ),
      };
      if (withMoney) {
        const prices = await tx.query<{ id: string; price: string }>(
          `select id, unit_price_ht_centimes::text as price from sales_order where id = any($1::uuid[])`,
          [[...new Set(sold.map((s) => s.orderId))]],
        );
        const price = new Map(prices.rows.map((p) => [p.id, centimes(Number(p.price))]));
        const priced: PricedLoad[] = sold.flatMap((s) => {
          const unit = price.get(s.orderId);
          return unit === undefined ? [] : [{ ...s.load, unitPriceHtCentimes: unit }];
        });
        result.amounts = amountBy(priced, period, dimension);
      }
      return result;
    }),
  );
}

export interface PlantVolume {
  plantId: string | null;
  code: string | null;
  name: string | null;
  /** Litres loaded in the period, net of cancellations (a cancellation counts on the date of its load). */
  volumeL: number;
  loads: number;
}

export interface VolumeByPlant {
  from: string;
  to: string;
  plants: PlantVolume[];
  /** Always the sum of the plants (rows with no plant, from before plants existed, are one more row). */
  totalL: number;
}

/** m³ per plant and in total (REQUIREMENTS-V1 §1). Quantities only: no money key. */
export async function getVolumeByPlant(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { from: string; to: string },
): Promise<Result<VolumeByPlant, 'INVALID'>> {
  await require(appPool, actor, 'analytics.read');
  if (!isRealDate(input.from) || !isRealDate(input.to) || input.to < input.from) return err('INVALID');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      plant_id: string | null;
      code: string | null;
      name: string | null;
      volume_l: string;
      loads: string;
    }>(
      `select d.plant_id, p.code, p.name, sum(d.volume_l)::text as volume_l, count(*) filter (where d.reverses_id is null)::text as loads
         from delivery d
         left join delivery orig on orig.id = d.reverses_id
         left join plant p on p.id = d.plant_id
        where coalesce(orig.load_date, d.load_date) between $1 and $2
        group by d.plant_id, p.code, p.name order by p.code nulls last`,
      [input.from, input.to],
    ),
  );
  const plants = rows.map((r) => ({
    plantId: r.plant_id,
    code: r.code,
    name: r.name,
    volumeL: Number(r.volume_l),
    loads: Number(r.loads),
  }));
  return ok({ from: input.from, to: input.to, plants, totalL: plants.reduce((n, p) => n + p.volumeL, 0) });
}
