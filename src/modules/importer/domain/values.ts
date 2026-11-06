import { type Centimes, parseCentimes } from '@/lib/money';

// Cell values of an import: parsed by deterministic code, strictly. A value that can be read two ways is refused with a reason the
// report shows; the importer never guesses. No model touches an amount.

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * An amount in MAD as integer centimes. Accepts "1250", "1 250,50", "1250.5" (at most two decimals, no sign). Refuses: empty,
 * negative, scientific notation, a single separator followed by exactly three digits ("1,234" may be 1234 or 1.234), a thousands
 * separator mixed with a decimal one ("1.234,50"), three or more decimals (a spreadsheet float such as 1234.4999999999998).
 */
export function parseImportAmount(text: string): Parsed<Centimes> {
  const t = text.replace(/[\s  ]/g, '');
  if (t === '') return { ok: false, reason: 'amount is empty' };
  if (t.startsWith('-') || t.startsWith('(')) return { ok: false, reason: 'amount is negative' };
  if (/[eE]/.test(t)) return { ok: false, reason: 'amount in scientific notation' };
  if (/^\d{1,3}([.,]\d{3})+([.,]\d+)?$/.test(t) && !/^\d+[.,]\d{1,2}$/.test(t))
    return { ok: false, reason: 'ambiguous amount (thousands separator or decimals): write 1250,50' };
  if (/^\d+[.,]\d{3,}$/.test(t)) return { ok: false, reason: 'more than two decimals' };
  const cents = parseCentimes(t);
  return cents === null
    ? { ok: false, reason: 'not an amount in MAD (digits, at most two decimals)' }
    : { ok: true, value: cents };
}

/** A whole number from a cell ("12", "12.0" as a spreadsheet writes it); anything else is refused. */
export function parseWholeNumber(text: string, min: number, max: number): Parsed<number> {
  const t = text.replace(/[\s  ]/g, '');
  const m = /^(\d{1,9})(?:[.,]0+)?$/.exec(t);
  if (!m) return { ok: false, reason: 'not a whole number' };
  const n = Number(m[1]);
  return n < min || n > max ? { ok: false, reason: `outside ${min} to ${max}` } : { ok: true, value: n };
}
