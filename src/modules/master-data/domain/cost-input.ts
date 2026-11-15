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

/** "10", "7,5" or "12.25" typed as a percentage (1 bp to 100 %, 2 decimals at most) -> integer basis points (1 000 = 10 %). Never a float. */
export function parsePercentToBp(text: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.replace(/[\s  ]/g, ''));
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bp >= 1 && bp <= 10_000 ? bp : null;
}

/** Basis points -> "10" or "7,5" percent, display only. */
export function formatBp(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = String(bp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return frac ? `${whole},${frac}` : String(whole);
}
