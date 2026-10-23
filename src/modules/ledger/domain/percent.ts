/** "40", "33,33" or "12.5" typed as a percentage (0 < p <= 100, 2 decimals at most) → basis points (10 000 = 100 %). */
export function parsePercentBp(text: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bp >= 1 && bp <= 10_000 ? bp : null;
}

/** 3333 → "33,33" (display only). */
export function formatPercentBp(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const rest = bp % 100;
  return rest === 0 ? String(whole) : `${whole},${String(rest).padStart(2, '0').replace(/0$/, '')}`;
}
