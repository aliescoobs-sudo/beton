import { type Centimes, mulDivRound } from '@/lib/money';
import { addDaysIso, daysBetween } from '@/modules/ledger';
import { consumptionForLoad } from '@/modules/operations';
import { forecastDates, type Calendar } from './calendar';

export interface StockComponent {
  id: string;
  nameFr: string;
  nameAr: string;
  baseUnit: string;
  /** Integer base units in stock today (Σ movements). */
  level: number;
  lowThreshold: number | null;
}

/** Volume of an order still to load, on the day it is to be delivered. */
export interface StockDemand {
  orderId: string;
  orderCode: string;
  clientCode: string;
  typeId: string;
  typeLabel: string;
  date: string;
  /** Litres still to load (never negative). */
  volumeL: number;
}

/** A recette version: from `effectiveFrom` on, `qtyPerM3` base units of each component per m³. */
export interface RecetteVersion {
  effectiveFrom: string;
  lines: { componentId: string; qtyPerM3: number }[];
}

export interface ExpectedReceipt {
  purchaseId: string;
  purchaseCode: string;
  componentId: string;
  qtyBase: number;
  /** When the goods are expected (order date + lead days, never before today). */
  date: string;
}

export interface StockRiskInput {
  today: string;
  horizonDays: number;
  calendar: Calendar;
  components: readonly StockComponent[];
  demands: readonly StockDemand[];
  recettes: ReadonlyMap<string, readonly RecetteVersion[]>;
  receipts: readonly ExpectedReceipt[];
}

export interface Contribution {
  orderId: string;
  orderCode: string;
  clientCode: string;
  date: string;
  qty: number;
}

export interface StockDay {
  date: string;
  level: number;
  demand: number;
  receipts: number;
}

export interface ComponentProjection {
  componentId: string;
  nameFr: string;
  nameAr: string;
  baseUnit: string;
  level: number;
  lowThreshold: number | null;
  days: StockDay[];
  /** Total needs of the open orders over the horizon, in base units. */
  needs: number;
  expectedReceipts: number;
  minLevel: number;
  /** The first day the level is below zero. */
  firstShortage: { date: string; level: number } | null;
  /** The first day the level is below the threshold while still not negative. */
  firstLow: { date: string; level: number } | null;
  /** What is missing at the worst point (≥ 0). */
  maxShortage: number;
  /** Calendar days from today to the first shortage; null when none. */
  daysUntilShortage: number | null;
  contributions: Contribution[];
}

export interface StockRisk {
  components: ComponentProjection[];
  /** Orders whose concrete type has no recette in force at their date: their needs are unknown, never zero. */
  missingRecette: { orderCode: string; typeLabel: string; date: string }[];
}

/** The latest version in force on a date, or null before the first one. */
export function recetteInForce(versions: readonly RecetteVersion[], date: string): RecetteVersion | null {
  let best: RecetteVersion | null = null;
  for (const v of versions) {
    if (v.effectiveFrom <= date && (best === null || v.effectiveFrom > best.effectiveFrom)) best = v;
  }
  return best;
}

/**
 * Day-by-day projection of every component (R5): today's stock, minus what the open orders need (the recette in force on
 * the day of the load, one rounding per line like the real load), plus the receipts expected. A demand dated before today
 * counts today (it is late, not gone). Pure and deterministic; the plant and the partner read it (no money in it).
 */
export function projectStock(input: StockRiskInput): StockRisk {
  const dates = forecastDates(input.today, input.horizonDays, input.calendar);
  const bucket = (date: string): number => {
    for (let i = 0; i < dates.length; i++) if ((dates[i] as string) >= date) return i;
    return -1;
  };

  const demandByComponent = new Map<string, number[]>();
  const receiptByComponent = new Map<string, number[]>();
  const contributions = new Map<string, Contribution[]>();
  const missingRecette: StockRisk['missingRecette'] = [];
  const slot = (map: Map<string, number[]>, id: string) => {
    let row = map.get(id);
    if (!row) map.set(id, (row = dates.map(() => 0)));
    return row;
  };

  const add = (row: number[], i: number, v: number) => void (row[i] = (row[i] ?? 0) + v);
  const demands = [...input.demands].sort(
    (a, b) => a.date.localeCompare(b.date) || a.orderCode.localeCompare(b.orderCode),
  );
  for (const d of demands) {
    if (d.volumeL <= 0) continue;
    const date = d.date < input.today ? input.today : d.date;
    const i = bucket(date);
    if (i < 0) continue;
    const recette = recetteInForce(input.recettes.get(d.typeId) ?? [], date);
    if (!recette) {
      missingRecette.push({ orderCode: d.orderCode, typeLabel: d.typeLabel, date });
      continue;
    }
    for (const q of consumptionForLoad(
      recette.lines.map((l) => ({ componentId: l.componentId, qtyPerM3: l.qtyPerM3 })),
      d.volumeL,
    )) {
      add(slot(demandByComponent, q.componentId), i, q.qtyBase);
      let list = contributions.get(q.componentId);
      if (!list) contributions.set(q.componentId, (list = []));
      list.push({
        orderId: d.orderId,
        orderCode: d.orderCode,
        clientCode: d.clientCode,
        date,
        qty: q.qtyBase,
      });
    }
  }
  for (const r of input.receipts) {
    const i = bucket(r.date < input.today ? input.today : r.date);
    if (i >= 0) add(slot(receiptByComponent, r.componentId), i, r.qtyBase);
  }

  const components = input.components.map<ComponentProjection>((c) => {
    const demand = demandByComponent.get(c.id) ?? dates.map(() => 0);
    const receipts = receiptByComponent.get(c.id) ?? dates.map(() => 0);
    let level = c.level;
    let minLevel = c.level;
    let firstShortage: ComponentProjection['firstShortage'] = null;
    let firstLow: ComponentProjection['firstLow'] = null;
    const days = dates.map<StockDay>((date, i) => {
      level = level - (demand[i] as number) + (receipts[i] as number);
      minLevel = Math.min(minLevel, level);
      if (level < 0 && !firstShortage) firstShortage = { date, level };
      if (level >= 0 && c.lowThreshold !== null && level < c.lowThreshold && !firstLow)
        firstLow = { date, level };
      return { date, level, demand: demand[i] as number, receipts: receipts[i] as number };
    });
    return {
      componentId: c.id,
      nameFr: c.nameFr,
      nameAr: c.nameAr,
      baseUnit: c.baseUnit,
      level: c.level,
      lowThreshold: c.lowThreshold,
      days,
      needs: demand.reduce((s, v) => s + v, 0),
      expectedReceipts: receipts.reduce((s, v) => s + v, 0),
      minLevel,
      firstShortage,
      // A shortage is the bigger alert: a low level on a later day is not reported separately.
      firstLow: firstShortage ? null : firstLow,
      maxShortage: Math.max(0, -minLevel),
      daysUntilShortage: firstShortage
        ? daysBetween(input.today, (firstShortage as { date: string }).date)
        : null,
      contributions: contributions.get(c.id) ?? [],
    };
  });
  return { components, missingRecette };
}

/** Moves part of an order's volume to another day (the "split delivery" what-if). */
export function splitDemand(
  demands: readonly StockDemand[],
  orderId: string,
  date: string,
  movedL: number,
  toDate: string,
): StockDemand[] {
  const out: StockDemand[] = [];
  for (const d of demands) {
    if (d.orderId === orderId && d.date === date && d.volumeL >= movedL && movedL > 0) {
      out.push({ ...d, volumeL: d.volumeL - movedL }, { ...d, date: toDate, volumeL: movedL });
    } else out.push(d);
  }
  return out;
}

/** What the service knows of the preferred supplier of a component: the last purchase line. */
export interface SupplierHint {
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  purchaseUnitId: string;
  unitLabel: string;
  factorToBase: number;
  /** Last unit price HT per purchase unit; null when never bought. */
  lastUnitPriceHt: Centimes | null;
  /** Days between the order and the due date of the last purchase (the supplier's terms); null when unknown. */
  termDays: number | null;
  /** The supplier's lead time in calendar days (supplier.lead_time_days); null when it has none. */
  leadTimeDays: number | null;
}

export interface PurchaseDraft {
  componentId: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  purchaseUnitId: string;
  unitLabel: string;
  /** Thousandths of the purchase unit, rounded up so the stock is covered. */
  qtyMilli: number;
  qtyBase: number;
  /** Estimated HT at the last price, null when there is none. */
  estimatedHtCentimes: Centimes | null;
  /** When it would be due at the supplier's usual terms. */
  dueDate: string | null;
}

/**
 * A draft purchase that brings the worst level of the horizon back up to the low threshold (or to zero when there is
 * none), at the last price and the last supplier's terms. Only a draft: the owner decides and enters it.
 */
export function draftPurchase(
  projection: ComponentProjection,
  hint: SupplierHint | null,
  today: string,
): PurchaseDraft | null {
  if (!hint || hint.factorToBase <= 0) return null;
  const target = projection.lowThreshold ?? 0;
  const needBase = target - projection.minLevel;
  if (needBase <= 0) return null;
  // Round up to a whole thousandth of the purchase unit.
  const qtyMilli = Number(
    (BigInt(needBase) * 1000n + BigInt(hint.factorToBase) - 1n) / BigInt(hint.factorToBase),
  );
  const qtyBase = Number((BigInt(qtyMilli) * BigInt(hint.factorToBase)) / 1000n);
  return {
    componentId: projection.componentId,
    supplierId: hint.supplierId,
    supplierCode: hint.supplierCode,
    supplierName: hint.supplierName,
    purchaseUnitId: hint.purchaseUnitId,
    unitLabel: hint.unitLabel,
    qtyMilli,
    qtyBase,
    estimatedHtCentimes:
      hint.lastUnitPriceHt === null ? null : mulDivRound(hint.lastUnitPriceHt, qtyMilli, 1000),
    dueDate: hint.termDays === null ? null : addDaysIso(today, hint.termDays),
  };
}
