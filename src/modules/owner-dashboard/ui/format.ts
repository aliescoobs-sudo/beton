import { formatCentimes } from '@/lib/money';
import { formatStockQty } from '@/modules/operations/ui/format';

/** Latin digits in both locales (the app's convention for figures); only the words and the weekday follow the language. */
const localeTag = (locale: string) => (locale === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-FR');

/** "lun. 02/11" (fr) or the Arabic weekday and the same numbers (ar). */
export function formatDay(date: string, locale: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  const weekday = new Intl.DateTimeFormat(localeTag(locale), { weekday: 'short', timeZone: 'UTC' }).format(
    at,
  );
  return `${weekday} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

/** "02/11/2026" */
export function formatDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

/** Wraps a Latin code in a left-to-right isolate so it keeps its order inside Arabic text. */
export const ltr = (s: string): string => `\u2066${s}\u2069`;

export const moneyText = (centimes: number): string => `${formatCentimes(centimes)} MAD`;

/** Basis points as a percentage with one decimal and a decimal comma: 9647 → "96,5 %". */
export function formatBp(bp: number): string {
  const tenths = Math.round(bp / 10);
  const whole = Math.trunc(tenths / 10);
  const frac = tenths % 10;
  return `${whole}${frac === 0 ? '' : `,${frac}`} %`;
}

export function qtyText(qtyBase: number, baseUnit: string): string {
  const q = formatStockQty(qtyBase, baseUnit);
  return `${q.value} ${q.unit}`;
}

/** Thousandths of a purchase unit as text: 1700 → "1,7". */
export const milliText = (milli: number): string =>
  (milli / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 3, useGrouping: false });

/** Litres as m³ text: 4000 → "4". */
export const m3Text = (litres: number): string =>
  (litres / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 3, useGrouping: false });
