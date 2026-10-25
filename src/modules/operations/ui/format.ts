/** Litres as m³ text with at most three decimals ("8", "7,5"); the decimal comma of the French catalogue. */
export function formatM3(litres: number): string {
  return (litres / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 3, useGrouping: false });
}

/** A stock quantity in its base unit (g, mL, L) as kg or L with thousands separators, never a fraction of a unit. */
export function formatStockQty(qtyBase: number, baseUnit: string): { value: string; unit: string } {
  const big = baseUnit === 'g' || baseUnit === 'mL';
  const value = big ? qtyBase / 1000 : qtyBase;
  return {
    value: value.toLocaleString('fr-FR', { maximumFractionDigits: big ? 1 : 0 }).replace(/[  ]/g, ' '),
    unit: baseUnit === 'g' ? 'kg' : 'L',
  };
}

/** Wraps a Latin code in a left-to-right isolate so it keeps its order inside Arabic text. */
export const ltr = (text: string): string => `\u2066${text}\u2069`;

const CLOCK = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Africa/Casablanca',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "08:40" (Casablanca time) of an ISO instant. */
export const formatTime = (iso: string): string => CLOCK.format(new Date(iso));
