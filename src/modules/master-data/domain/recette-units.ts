import { parseMilliQty, toBase } from '@/lib/quantity';
import { err, ok, type Result } from '@/lib/result';
import type { BaseUnit } from './component';

/** Units a person may type a recette quantity in, per component base unit; the first is the default. */
export const ENTRY_UNITS = {
  g: [
    { unit: 'kg', factorToBase: 1000 },
    { unit: 't', factorToBase: 1_000_000 },
  ],
  mL: [
    { unit: 'mL', factorToBase: 1 },
    { unit: 'L', factorToBase: 1000 },
  ],
  L: [{ unit: 'L', factorToBase: 1 }],
} as const satisfies Record<BaseUnit, readonly { unit: string; factorToBase: number }[]>;

export type EntryUnit = (typeof ENTRY_UNITS)[BaseUnit][number]['unit'];

export const defaultEntryUnit = (baseUnit: BaseUnit): EntryUnit => ENTRY_UNITS[baseUnit][0].unit;

const factorOf = (baseUnit: BaseUnit, unit: string): number | undefined =>
  ENTRY_UNITS[baseUnit].find((u) => u.unit === unit)?.factorToBase;

export type QtyEntryError = 'INVALID_QUANTITY' | 'UNKNOWN_UNIT' | 'FRACTIONAL_BASE_UNIT';

/**
 * "350", "350,5" (kg) → integer base units (350 500 g). Converted with integers only; a value that is not a whole
 * number of base units (0,0005 kg) is refused, never rounded.
 */
export function parseEntryQty(text: string, baseUnit: BaseUnit, unit: string): Result<number, QtyEntryError> {
  const factor = factorOf(baseUnit, unit);
  if (factor === undefined) return err('UNKNOWN_UNIT');
  const milli = parseMilliQty(text);
  if (!milli.ok) return err('INVALID_QUANTITY');
  const base = toBase(milli.value, factor);
  return base.ok ? ok(base.value) : err('FRACTIONAL_BASE_UNIT');
}

/** Integer base units → the text shown in `unit` (350000 g in kg → "350"; 350500 → "350,5"). */
export function formatEntryQty(qty: number, baseUnit: BaseUnit, unit: string): string {
  const factor = factorOf(baseUnit, unit) ?? 1;
  const whole = Math.trunc(qty / factor);
  const rest = qty % factor;
  if (rest === 0) return String(whole);
  const digits = String(factor).length - 1;
  return `${whole},${String(rest).padStart(digits, '0').replace(/0+$/, '')}`;
}

/** A quantity this many times larger or smaller than the previous version is probably a typing slip (unit or zero). */
export const MAGNITUDE_FACTOR = 10;

/** Components whose new quantity is at least 10× or at most 1/10 of the previous version's (new components are not compared). */
export function magnitudeWarnings(
  next: readonly { componentId: string; qtyPerM3: number }[],
  previous: readonly { componentId: string; qtyPerM3: number }[],
): string[] {
  const before = new Map(previous.map((l) => [l.componentId, l.qtyPerM3]));
  return next
    .filter((l) => {
      const old = before.get(l.componentId);
      return (
        old !== undefined && (l.qtyPerM3 >= old * MAGNITUDE_FACTOR || l.qtyPerM3 * MAGNITUDE_FACTOR <= old)
      );
    })
    .map((l) => l.componentId);
}
