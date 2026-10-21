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

/** "1450", "1 450,5" or "1450.00" typed by a person (MAD, at most 2 decimals, no sign) → centimes. Never a float. */
export function parseCentimes(text: string): Centimes | null {
  const match = /^(\d{1,10})(?:[.,](\d{1,2}))?$/.exec(text.replace(/[\s  ]/g, ''));
  if (!match) return null;
  return centimes(Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')));
}

/** 362500 → "3 625,00" (MAD, thin-space thousands, decimal comma). Display only. */
export function formatCentimes(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const whole = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${whole},${String(abs % 100).padStart(2, '0')}`;
}
