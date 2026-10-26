/** Litres to m³, to the litre (three decimals): the tools convert so the model never has to (SPEC-assistant §6). */
export function litresToM3(litres: number): number {
  return Math.round(litres) / 1000;
}

/** Minutes from midnight to "HH:MM". */
export function minutesToClock(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** The days between two ISO dates, whole, from a to b. */
export function daysBetweenIso(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export const isIsoDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/**
 * A stock quantity in a unit a person speaks in, converted by code: grams to tonnes (to the kilogram), millilitres to litres (to
 * the millilitre), litres as they are. The model quotes it and never converts, and no quantity is a run of six digits.
 */
export function displayQuantity(level: number, baseUnit: string): { value: number; unit: string } {
  if (baseUnit === 'g') return { value: Math.round(level / 1000) / 1000, unit: 't' };
  if (baseUnit === 'mL') return { value: Math.round(level) / 1000, unit: 'L' };
  return { value: Math.round(level * 1000) / 1000, unit: baseUnit };
}
