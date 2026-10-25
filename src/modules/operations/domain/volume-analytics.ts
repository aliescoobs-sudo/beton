import { type Centimes, centimes, mulDivRound } from '@/lib/money';
import { periodKey, type ReportPeriod } from './consumption-report';

/**
 * Sales volume analytics (SPEC-operations §7.3, AC-OPS-24). Pure: m³ delivered per period and per client, concrete type or
 * zone, from the live loads. The quantity side has no money field at all (the partner reads it); the amount side is a
 * separate function, fed with the order's unit price, and only the owner and support receive its result.
 */
export type Dimension = 'client' | 'type' | 'zone';

export interface SoldLoad {
  /** Date of the load (a cancellation counts on the date of the load it cancels). */
  date: string;
  clientId: string;
  clientCode: string;
  typeId: string;
  typeLabel: string;
  /** Null for an order whose site has no zone. */
  zoneId: string | null;
  zoneName: string | null;
  /** Litres; negative on a cancellation. */
  volumeL: number;
}

/** The same load with the order's unit price (HT per m³): the money side. */
export interface PricedLoad extends SoldLoad {
  unitPriceHtCentimes: Centimes;
}

export interface VolumeRow {
  period: string;
  key: string;
  label: string;
  volumeL: number;
}

export interface AmountRow extends VolumeRow {
  /** Σ over the loads of volume × the order's unit price ÷ 1000, each load rounded once (HT). */
  amountHtCentimes: Centimes;
}

const NO_ZONE = '—';

const keyOf = (l: SoldLoad, dimension: Dimension): { key: string; label: string } =>
  dimension === 'client'
    ? { key: l.clientId, label: l.clientCode }
    : dimension === 'type'
      ? { key: l.typeId, label: l.typeLabel }
      : { key: l.zoneId ?? 'none', label: l.zoneName ?? NO_ZONE };

const order = (a: VolumeRow, b: VolumeRow): number =>
  a.period.localeCompare(b.period) || b.volumeL - a.volumeL || a.label.localeCompare(b.label);

/** m³ per period and dimension, biggest first inside a period. */
export function volumeBy(
  loads: readonly SoldLoad[],
  period: ReportPeriod,
  dimension: Dimension,
): VolumeRow[] {
  const rows = new Map<string, VolumeRow>();
  for (const l of loads) {
    const p = periodKey(l.date, period);
    const k = keyOf(l, dimension);
    const id = `${p}|${k.key}`;
    const row = rows.get(id) ?? { period: p, key: k.key, label: k.label, volumeL: 0 };
    row.volumeL += l.volumeL;
    rows.set(id, row);
  }
  return [...rows.values()].sort(order);
}

/** The amount side: owner and support only. */
export function amountBy(
  loads: readonly PricedLoad[],
  period: ReportPeriod,
  dimension: Dimension,
): AmountRow[] {
  const rows = new Map<string, AmountRow>();
  for (const l of loads) {
    const p = periodKey(l.date, period);
    const k = keyOf(l, dimension);
    const id = `${p}|${k.key}`;
    const row = rows.get(id) ?? {
      period: p,
      key: k.key,
      label: k.label,
      volumeL: 0,
      amountHtCentimes: centimes(0),
    };
    row.volumeL += l.volumeL;
    row.amountHtCentimes = centimes(
      (row.amountHtCentimes as number) + (mulDivRound(l.unitPriceHtCentimes, l.volumeL, 1000) as number),
    );
    rows.set(id, row);
  }
  return [...rows.values()].sort(order);
}
