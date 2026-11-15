/** "22", "22,5" or "22.250" litres typed by a person (at most 3 decimals, no sign) -> integer millilitres. Never a float. */
export function parseLitresToMl(text: string): number | null {
  const match = /^(\d{1,7})(?:[.,](\d{1,3}))?$/.exec(text.replace(/[\s  ]/g, ''));
  if (!match) return null;
  return Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
}

/** Millilitres -> "22" or "22,25" litres, display only. */
export function formatMl(ml: number): string {
  const whole = Math.trunc(ml / 1000);
  const frac = String(ml % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return frac ? `${whole},${frac}` : String(whole);
}
