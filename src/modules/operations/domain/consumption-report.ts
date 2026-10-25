/**
 * Production and consumption report (SPEC-operations §7.3, AC-OPS-18, 19). Pure arithmetic over stored facts: the loads and
 * the stock movements already written at each load (the recette in force on its date), and the physical-count
 * adjustments. No price, no clock.
 */

export type ReportPeriod = 'day' | 'week' | 'month';

/** "2026-11-02" (day), "2026-W45" (ISO week) or "2026-11" (month) of a business date. */
export function periodKey(date: string, period: ReportPeriod): string {
  if (period === 'day') return date;
  if (period === 'month') return date.slice(0, 7);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  // ISO week: the week of the Thursday of that week.
  const day = at.getUTCDay() || 7;
  at.setUTCDate(at.getUTCDate() + 4 - day);
  const year = at.getUTCFullYear();
  const week = Math.ceil(((at.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export interface LoadFact {
  /** The date of the load (a cancellation counts on the date of the load it cancels). */
  date: string;
  typeId: string;
  typeLabel: string;
  /** Litres, negative on a cancellation. */
  volumeL: number;
}

export interface ProducedRow {
  period: string;
  typeId: string;
  typeLabel: string;
  volumeL: number;
}

/** m³ produced per concrete type and period: the sum of the live loads, cancellations netted out (AC-OPS-18). */
export function producedByType(loads: readonly LoadFact[], period: ReportPeriod): ProducedRow[] {
  const rows = new Map<string, ProducedRow>();
  for (const l of loads) {
    const p = periodKey(l.date, period);
    const key = `${p}|${l.typeId}`;
    const row = rows.get(key) ?? { period: p, typeId: l.typeId, typeLabel: l.typeLabel, volumeL: 0 };
    row.volumeL += l.volumeL;
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (a, b) => a.period.localeCompare(b.period) || a.typeLabel.localeCompare(b.typeLabel),
  );
}

export type MovementSource = 'delivery' | 'reversal' | 'count_adjustment' | 'receipt' | 'opening';

export interface MovementFact {
  componentId: string;
  /** The date of the movement (a reversal counts on the date of the movement it reverses). */
  date: string;
  /** Base units, signed (a load takes stock out: negative). */
  qtyBase: number;
  source: MovementSource;
}

export interface ConsumptionRow {
  period: string;
  componentId: string;
  /** What the recettes say the loads used (positive base units). */
  theoretical: number;
  /** Sum of the count adjustments of the period (signed: negative = the count found less than the books). */
  adjustments: number;
  /** Whether a physical count was recorded in the period. Without one there is no actual figure. */
  counted: boolean;
  /** Theoretical minus the adjustments; null without a count. */
  actual: number | null;
  /** Actual minus theoretical (positive: more was used than planned); null without a count. */
  variance: number | null;
  /** The variance as a share of the theoretical consumption, in basis points (rounded half away from zero); null when not defined. */
  varianceBp: number | null;
  /** Above the tolerance, or a variance against a theoretical of zero. */
  flagged: boolean;
}

/** Rounded integer quotient, half away from zero, den > 0. */
function roundDiv(num: number, den: number): number {
  const q = Math.abs(num) / den;
  const r = Math.floor(q + 0.5);
  return num < 0 ? -r : r;
}

/**
 * Theoretical consumption per component and period against the physical counts (AC-OPS-19). Receipts and openings are in
 * both sides of the arithmetic (a receipt raises the books and the shelf alike) so they never enter the variance. The
 * flag compares exactly (|variance| × 10 000 > tolerance × theoretical), never through a rounded percentage.
 */
export function consumptionReport(
  movements: readonly MovementFact[],
  period: ReportPeriod,
  toleranceBp: number,
): ConsumptionRow[] {
  const rows = new Map<string, ConsumptionRow>();
  const row = (componentId: string, p: string): ConsumptionRow => {
    const key = `${p}|${componentId}`;
    let r = rows.get(key);
    if (!r) {
      r = {
        period: p,
        componentId,
        theoretical: 0,
        adjustments: 0,
        counted: false,
        actual: null,
        variance: null,
        varianceBp: null,
        flagged: false,
      };
      rows.set(key, r);
    }
    return r;
  };
  for (const m of movements) {
    const r = row(m.componentId, periodKey(m.date, period));
    if (m.source === 'delivery' || m.source === 'reversal') r.theoretical -= m.qtyBase;
    else if (m.source === 'count_adjustment') {
      r.adjustments += m.qtyBase;
      r.counted = true;
    }
  }
  const out = [...rows.values()];
  for (const r of out) {
    if (!r.counted) continue;
    r.actual = r.theoretical - r.adjustments;
    r.variance = r.actual - r.theoretical;
    r.varianceBp = r.theoretical === 0 ? null : roundDiv(r.variance * 10_000, r.theoretical);
    r.flagged =
      r.theoretical === 0 ? r.variance !== 0 : Math.abs(r.variance) * 10_000 > toleranceBp * r.theoretical;
  }
  return out.sort((a, b) => a.period.localeCompare(b.period) || a.componentId.localeCompare(b.componentId));
}

export interface LostComponentFact {
  date: string;
  componentId: string;
  /** Base units of the component the lost concrete used (positive). */
  qtyBase: number;
}

export interface LostComponentRow {
  period: string;
  componentId: string;
  qtyBase: number;
}

/** The components the lost concrete consumed, per period (O14): part of the theoretical consumption, shown as its own line. */
export function lostComponents(
  facts: readonly LostComponentFact[],
  period: ReportPeriod,
): LostComponentRow[] {
  const rows = new Map<string, LostComponentRow>();
  for (const f of facts) {
    const p = periodKey(f.date, period);
    const key = `${p}|${f.componentId}`;
    const row = rows.get(key) ?? { period: p, componentId: f.componentId, qtyBase: 0 };
    row.qtyBase += f.qtyBase;
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (a, b) => a.period.localeCompare(b.period) || a.componentId.localeCompare(b.componentId),
  );
}
