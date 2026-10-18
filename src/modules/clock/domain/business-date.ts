/** A calendar date in the company's time zone, as `YYYY-MM-DD`. */
export type BusinessDate = string & { readonly __brand: 'BusinessDate' };

export const BUSINESS_TIME_ZONE = 'Africa/Casablanca';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Casablanca calendar date of an instant (handles the Ramadan switch to UTC+0). */
export function businessDateOf(instant: Date): BusinessDate {
  return formatter.format(instant) as BusinessDate;
}
