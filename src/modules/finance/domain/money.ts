/** Exact arithmetic, including intermediate products; reject values JS cannot serialize exactly. */
export function integer(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('UNSAFE_INTEGER');
  return value;
}
export function exact(value: bigint): number {
  return integer(Number(value));
}
export const sum = (values: readonly number[]) => exact(values.reduce((s, v) => s + BigInt(integer(v)), 0n));
export const subtract = (a: number, b: number) => exact(BigInt(integer(a)) - BigInt(integer(b)));
export function scale(amount: number, numerator: number, denominator: number): number {
  integer(amount);
  integer(numerator);
  integer(denominator);
  if (denominator <= 0) throw new Error('INVALID_DENOMINATOR');
  const n = BigInt(amount) * BigInt(numerator),
    d = BigInt(denominator);
  return exact(((n < 0n ? -1n : 1n) * ((n < 0n ? -n : n) + d / 2n)) / d);
}
/** Largest remainder, stable plant-id order: allocations always sum to the original centime. */
export function allocate(amount: number, weights: Record<string, number>): Record<string, number> {
  integer(amount);
  const entries = Object.entries(weights).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length || entries.some(([, w]) => !Number.isSafeInteger(w) || w < 0))
    throw new Error('INVALID_KEY');
  const total = entries.reduce((s, [, w]) => s + BigInt(w), 0n);
  if (!total) throw new Error('EMPTY_KEY');
  const sign = amount < 0 ? -1 : 1,
    a = BigInt(amount < 0 ? -amount : amount);
  const parts = entries.map(([id, w]) => ({ id, n: (a * BigInt(w)) / total, r: (a * BigInt(w)) % total }));
  let left = a - parts.reduce((s, p) => s + p.n, 0n);
  for (const p of [...parts].sort((x, y) => (x.r === y.r ? x.id.localeCompare(y.id) : x.r > y.r ? -1 : 1))) {
    if (!left) break;
    p.n++;
    left--;
  }
  return Object.fromEntries(parts.map((p) => [p.id, exact(p.n) * sign]));
}
