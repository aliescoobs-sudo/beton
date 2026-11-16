// T20 item 4: the stock plan, pure and deterministic. Consumption is NOT planned here: it comes from the BLs the stock engine already wrote. This only decides the opening
// stock and the purchases that keep every component above zero on every day, with a reorder rule (buy a lot when the stock plus what is on its way falls under
// a few days of use) and a lead time, the way a plant manager buys.
import type { Rng } from '../../../src/modules/ledger/domain/scenario.ts';
import { addDays, isWorkingDay } from './context.ts';

export interface StockPlanInput {
  /** First and last day of the period; the opening stock is dated the day before the first. */
  start: string;
  end: string;
  /** Base units used on each date (positive numbers); a missing date is a day without use. */
  consumption: ReadonlyMap<string, number>;
  /** The smallest quantity one purchase can be made in, in base units (one tonne, one m³, one litre). */
  unit: number;
  /** Days of average use below which a purchase is made, and the size of a lot in days of use. */
  reorderDays: number;
  lotDays: number;
  leadDays: number;
}
export interface PlannedReceipt {
  orderDate: string;
  receiptDate: string;
  qty: number;
}
export interface StockPlan {
  opening: number;
  receipts: PlannedReceipt[];
  /** The lowest level reached over the period (never below zero by construction). */
  minLevel: number;
}

const roundUp = (n: number, unit: number) => Math.ceil(n / unit) * unit;

function simulate(
  input: StockPlanInput,
  opening: number,
  rng: Rng,
  avgDaily: number,
): { receipts: PlannedReceipt[]; minLevel: number } {
  const days: string[] = [];
  for (let d = input.start; d <= input.end; d = addDays(d, 1)) days.push(d);
  const arriving = new Map<string, number>();
  const receipts: PlannedReceipt[] = [];
  let level = opening;
  let inbound = 0;
  let min = level;
  for (const d of days) {
    const got = arriving.get(d) ?? 0;
    if (got) {
      level += got;
      inbound -= got;
    }
    level -= input.consumption.get(d) ?? 0;
    min = Math.min(min, level);
    if (level + inbound < avgDaily * input.reorderDays && isWorkingDay(d)) {
      const qty = roundUp(avgDaily * input.lotDays * (0.85 + rng.next() * 0.3), input.unit);
      let receiptDate = addDays(d, input.leadDays);
      while (!isWorkingDay(receiptDate)) receiptDate = addDays(receiptDate, 1);
      receipts.push({ orderDate: d, receiptDate, qty });
      arriving.set(receiptDate, (arriving.get(receiptDate) ?? 0) + qty);
      inbound += qty;
    }
  }
  return { receipts, minLevel: min };
}

/** Opening stock and receipts such that the level never goes below zero. The opening stock is raised, never the lots, if a first pass dips under zero. */
export function planReceipts(input: StockPlanInput, rng: Rng): StockPlan {
  let total = 0;
  for (const v of input.consumption.values()) total += v;
  const spanDays = Math.max(
    1,
    Math.round((Date.parse(input.end) - Date.parse(input.start)) / 86_400_000) + 1,
  );
  const avgDaily = Math.max(input.unit, total / spanDays);
  let opening = roundUp(avgDaily * (input.reorderDays + 3), input.unit);
  // the generator is cloned by re-seeding through its own stream: simulate with the same draws each time by replaying from a stored state
  const draws: number[] = Array.from({ length: 4000 }, () => rng.next());
  const replay = (): Rng => {
    let i = 0;
    const next = () => draws[i++ % draws.length] as number;
    return {
      next,
      int: (a, b) => a + Math.floor(next() * (b - a + 1)),
      pick: (items) => items[Math.floor(next() * items.length)] as never,
    };
  };
  let run = simulate(input, opening, replay(), avgDaily);
  // A raised opening changes when the rule buys, so look again until the lowest day still holds one day of use (each round adds at least one unit).
  for (let round = 0; run.minLevel < avgDaily && round < 50; round++) {
    opening += roundUp(avgDaily - run.minLevel, input.unit);
    run = simulate(input, opening, replay(), avgDaily);
  }
  if (run.minLevel < 0) throw new Error('twin seed: the stock plan could not keep a component above zero');
  // (the loop aims at one day of use in hand at the lowest point, so a refused part of a load can never take a plant to zero)
  return { opening, receipts: run.receipts, minLevel: run.minLevel };
}
