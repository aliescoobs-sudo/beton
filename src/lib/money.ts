export type Centimes = number & { readonly __brand: 'Centimes' };

export function centimes(value: number): Centimes {
  if (!Number.isSafeInteger(value)) throw new RangeError(`Not an integer centime amount: ${value}`);
  return value as Centimes;
}

/** amount × num / den, rounded half away from zero. The only way a fraction becomes money. */
export function mulDivRound(amount: Centimes, num: number, den: number): Centimes {
  if (!Number.isSafeInteger(num)) throw new RangeError(`Not an integer numerator: ${num}`);
  if (!Number.isSafeInteger(den) || den === 0) throw new RangeError(`Not a usable denominator: ${den}`);
  const sign = den < 0 ? -1n : 1n;
  const d = BigInt(den) * sign;
  const n = BigInt(amount) * BigInt(num) * sign;
  const q = n / d;
  const r = n % d;
  const away = (r < 0n ? -r : r) * 2n >= d;
  return centimes(Number(away ? q + (n < 0n ? -1n : 1n) : q));
}
