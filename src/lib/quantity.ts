import { type Centimes, mulDivRound } from './money';
import { err, ok, type Result } from './result';

/** Integer quantity in a component's base unit (g, mL or L). */
export type BaseQty = number & { readonly __brand: 'BaseQty' };

export function baseQty(value: number): BaseQty {
  if (!Number.isSafeInteger(value)) throw new RangeError(`Not an integer base quantity: ${value}`);
  return value as BaseQty;
}

/** A quantity typed by a person, in thousandths of a unit (2,5 t → 2500). Never a float. */
export type MilliQty = number & { readonly __brand: 'MilliQty' };

export type QuantityError = 'INVALID_QUANTITY' | 'INVALID_FACTOR' | 'FRACTIONAL_BASE_UNIT';

/** "2.5" or "2,5" (fr keyboard), up to 3 decimals, no sign, no exponent. */
export function parseMilliQty(text: string): Result<MilliQty, QuantityError> {
  const match = /^(\d{1,12})(?:[.,](\d{1,3}))?$/.exec(text.trim());
  if (!match) return err('INVALID_QUANTITY');
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(3, '0');
  return ok((Number(whole) * 1000 + Number(fraction)) as MilliQty);
}

/**
 * A quantity in a purchase unit → integer base units (2,5 t × 1 000 000 g/t = 2 500 000 g). A result that is not a
 * whole number of base units is refused, never rounded: rounding a quantity would silently change what is owed.
 */
export function toBase(qty: MilliQty, factorToBase: number): Result<BaseQty, QuantityError> {
  if (!Number.isSafeInteger(factorToBase) || factorToBase <= 0) return err('INVALID_FACTOR');
  const product = BigInt(qty) * BigInt(factorToBase);
  if (product % 1000n !== 0n) return err('FRACTIONAL_BASE_UNIT');
  return ok(baseQty(Number(product / 1000n)));
}

/** Cost of a base quantity at a price per purchase unit: qty × price / factor, one rounding (half away from zero). */
export function costOf(qty: BaseQty, pricePerUnit: Centimes, factorToBase: number): Centimes {
  return mulDivRound(pricePerUnit, qty, factorToBase);
}

/**
 * A base quantity scaled by num/den and rounded once, half away from zero (a recette line of 350 000 g per m³ for a load
 * of 8 000 L is 350 000 × 8 000 / 1 000). The one place a fraction of a quantity becomes a whole number of base units.
 */
export function scaleQty(qty: number, num: number, den: number): BaseQty {
  if (!Number.isSafeInteger(qty) || !Number.isSafeInteger(num))
    throw new RangeError('Not integer quantities');
  if (!Number.isSafeInteger(den) || den <= 0) throw new RangeError(`Not a usable denominator: ${den}`);
  const n = BigInt(qty) * BigInt(num);
  const d = BigInt(den);
  const q = n / d;
  const r = n % d;
  const away = (r < 0n ? -r : r) * 2n >= d;
  return baseQty(Number(away ? q + (n < 0n ? -1n : 1n) : q));
}
