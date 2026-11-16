// T20 item 2: the sales plan, pure and deterministic: which orders exist, for which client, plant, class, discharge method and volume, on which day, and which of
// them are cancelled. The writer (sales.ts) only carries this out through the application's own services, so the plan can be proved without a database.
import type { Rng } from '../../../src/modules/ledger/domain/scenario.ts';
import { addDays, isWorkingDay } from './context.ts';
import { type ClientSpec } from './data.ts';

export interface PlannedOrder {
  /** 0-based position in the plan (the order the writer creates them in). */
  n: number;
  plant: 'TET' | 'CHF';
  clientIdx: number;
  orderDate: string;
  deliveryDate: string;
  typeCode: 'B15' | 'B20' | 'B25' | 'B30' | 'B35';
  method: 'GOULOTTE' | 'POMPE';
  /** Whole or half cubic metres, in litres. */
  volumeL: number;
  preset: 'cash' | 'advance50' | 'installments3' | 'cheque30' | 'lcn';
  /** Days after delivery of the LCN (preset 'lcn' only). */
  lcnDays: number;
  clientPo: string | null;
  commercial: string;
  /** Cancelled before production (a reversing entry with this reason). */
  cancelReason: string | null;
  /** Set for a pump order: which pump (index) and the minute of the day it is on site. */
  pump: { pumpIdx: number; onSiteMin: number } | null;
}

export interface SalesPlanOptions {
  start: string;
  anchor: string;
  /** Orders already made for the days after the anchor (planned for tomorrow and the day after, so the order flow and the dispatch are not empty). */
  futureDays: number;
}

const VOLUMES_M3 = [6, 8, 10, 12, 16, 16, 20, 24, 32, 32, 40, 48, 60, 80, 96, 120];
const COMMERCIALS = ['COM-01', 'COM-02', 'COM-03'];
export const CANCEL_REASONS = [
  'Chantier reporté par le client (fictif)',
  'Pluie, coulage annulé (fictif)',
  'Commande saisie en double (fictif)',
  'Client sans autorisation de coulage (fictif)',
];

function weighted<T>(rng: Rng, items: readonly T[], weight: (t: T) => number): T {
  const total = items.reduce((a, t) => a + weight(t), 0);
  let r = rng.next() * total;
  for (const item of items) {
    r -= weight(item);
    if (r <= 0) return item;
  }
  return items[items.length - 1] as T;
}

/** The plan's payment preset follows the client's terms: private individuals pay at once or in advance, 30-day clients by cheque or instalments, long terms by LCN. */
function presetFor(rng: Rng, spec: ClientSpec): Pick<PlannedOrder, 'preset' | 'lcnDays'> {
  if (spec.terms === 0) return { preset: rng.next() < 0.6 ? 'cash' : 'advance50', lcnDays: 0 };
  if (spec.terms <= 15) return { preset: 'cash', lcnDays: 0 };
  if (spec.terms <= 30) {
    const r = rng.next();
    return {
      preset: r < 0.55 ? 'cheque30' : r < 0.8 ? 'installments3' : r < 0.9 ? 'advance50' : 'cash',
      lcnDays: 0,
    };
  }
  return { preset: rng.next() < 0.7 ? 'lcn' : 'installments3', lcnDays: spec.terms };
}

export function planSales(
  rng: Rng,
  clients: readonly { spec: ClientSpec }[],
  opts: SalesPlanOptions,
): PlannedOrder[] {
  const out: PlannedOrder[] = [];
  const poCounter = new Map<number, number>();
  const pumpBusy = new Map<string, number>(); // `${date}|${pumpIdx}` -> jobs that day
  const lastOrderDate = addDays(opts.anchor, opts.futureDays);
  for (let d = opts.start; d <= lastOrderDate; d = addDays(d, 1)) {
    if (!isWorkingDay(d)) continue;
    const future = d > opts.anchor;
    for (const plant of ['TET', 'CHF'] as const) {
      // Tétouan is the bigger plant. Mid-week is busier; the last days of a month a bit quieter; the future days only carry the orders already taken.
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      const base = plant === 'TET' ? 5.2 : 2.6;
      const mean = base * (dow === 6 ? 0.6 : dow === 5 ? 0.8 : 1);
      const count = future
        ? rng.next() < 0.7
          ? rng.int(1, 3)
          : 0
        : Math.max(0, Math.round(mean + (rng.next() - 0.5) * 4));
      const candidates = clients
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.spec.plant === plant || rng.next() < 0.12);
      for (let k = 0; k < count; k++) {
        const { c, i } = weighted(rng, candidates, (x) => x.c.spec.weight);
        const roll = rng.next();
        const typeCode =
          roll < 0.04 ? 'B15' : roll < 0.34 ? 'B20' : roll < 0.78 ? 'B25' : roll < 0.94 ? 'B30' : 'B35';
        const volumeM3 = rng.pick(VOLUMES_M3);
        const pumped = volumeM3 >= 16 && rng.next() < 0.3;
        const orderDate = future ? opts.anchor : d;
        const deliveryDate = future ? d : addDays(d, rng.next() < 0.6 ? 0 : rng.int(1, 2));
        // never on a Sunday: the plants are closed
        const delivery = !isWorkingDay(deliveryDate) ? addDays(deliveryDate, 1) : deliveryDate;
        const needsPo = c.spec.poRequired === true;
        const po =
          needsPo || rng.next() < 0.25
            ? `BC-${String(i + 1).padStart(2, '0')}-${String((poCounter.get(i) ?? 0) + 1).padStart(3, '0')}`
            : null;
        if (po) poCounter.set(i, (poCounter.get(i) ?? 0) + 1);
        const cancelled = !future && delivery <= opts.anchor && rng.next() < 0.025;
        let pump: PlannedOrder['pump'] = null;
        if (pumped && !cancelled) {
          const pumpIdx = rng.int(0, 2);
          const busy = pumpBusy.get(`${delivery}|${pumpIdx}`) ?? 0;
          if (busy < 3) {
            pumpBusy.set(`${delivery}|${pumpIdx}`, busy + 1);
            pump = { pumpIdx, onSiteMin: 420 + busy * 240 };
          }
        }
        out.push({
          n: out.length,
          plant,
          clientIdx: i,
          orderDate,
          deliveryDate: delivery,
          typeCode,
          method: pump ? 'POMPE' : 'GOULOTTE',
          volumeL: volumeM3 * 1000,
          ...presetFor(rng, c.spec),
          clientPo: po,
          commercial: rng.pick(COMMERCIALS),
          cancelReason: cancelled ? rng.pick(CANCEL_REASONS) : null,
          pump,
        });
      }
    }
  }
  return out;
}
