import { latinDigits } from './normalize';

/**
 * The post-check of an answer (SPEC-assistant §6): every number the model wrote must be one a tool returned in this turn. The
 * model may not add, subtract, round, convert, average or project, and the check does not rely on its obeying.
 */

const CODE = /\b[A-Z]{2,6}(?:-[A-Z0-9]+)+\b/g;
// A name that carries digits (T1, B25, CPJ45): a truck, a concrete type, a product. Allowed only as the data or the question wrote it.
const TOKEN = /\b[A-Za-z]{1,6}\d+[A-Za-z0-9]*\b/g;
const PLACEHOLDER = /\{\{(?:AMT|NUM)_\d+\}\}/g;
const DATE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const DATE_SLASH = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g;
const TIME = /\b(\d{1,2})\s?(?::|h)\s?(\d{2})\b/g;
const NUMBER = /\d+(?:[\s  .,]\d+)*/g;

/** One form for a number: no thousands separator, decimal point, no useless zeros. "7,50" and "7.5" are the same quantity. */
export function canonicalNumber(raw: string): string | null {
  const text = latinDigits(raw).replace(/[\s  ]/g, '');
  const decimal = /^(\d+)[.,](\d{1,2})$/.exec(text);
  const grouped = /^(\d{1,3})(?:[.,]\d{3})+$/.test(text);
  const clean = decimal
    ? `${decimal[1]}.${decimal[2]}`
    : grouped
      ? text.replace(/[.,]/g, '')
      : /^\d+$/.test(text)
        ? text
        : null;
  if (clean === null) return null;
  const value = Number(clean);
  return Number.isFinite(value) ? String(value) : null;
}

export interface Allowed {
  /** Numbers (and numeric strings) of the tool results, canonical. */
  quantities: Set<string>;
  /** Dates of the tool results, ISO. */
  dates: Set<string>;
  /** Times of the tool results, "H:MM" with the hour as a number. */
  times: Set<string>;
  /** Codes of the tool results and of the question. */
  codes: Set<string>;
}

function visit(value: unknown, into: Allowed, key?: string): void {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) into.quantities.add(String(value));
    return;
  }
  if (typeof value === 'string') {
    for (const m of value.matchAll(CODE)) into.codes.add(m[0]);
    for (const m of value.matchAll(TOKEN)) into.codes.add(m[0].toUpperCase());
    const text = value.replace(CODE, ' ').replace(PLACEHOLDER, ' ');
    for (const m of text.matchAll(DATE_ISO)) into.dates.add(m[0]);
    for (const m of text.matchAll(TIME)) into.times.add(`${Number(m[1])}:${m[2]}`);
    const rest = text.replace(DATE_ISO, ' ').replace(TIME, ' ');
    // A numeric field serialized as a string ("12.5"), not free text.
    if (key !== undefined && /^\d+(?:\.\d+)?$/.test(rest.trim())) {
      const c = canonicalNumber(rest.trim());
      if (c) into.quantities.add(c);
    }
    return;
  }
  if (Array.isArray(value)) for (const v of value) visit(v, into, key);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, into, k);
}

/** What the answer may quote: the tool results of the turn and the codes of the (pseudonymized) question. */
export function allowedFrom(toolResults: readonly unknown[], questionText: string): Allowed {
  const allowed: Allowed = { quantities: new Set(), dates: new Set(), times: new Set(), codes: new Set() };
  for (const r of toolResults) visit(r, allowed);
  for (const m of questionText.matchAll(CODE)) allowed.codes.add(m[0]);
  for (const m of questionText.matchAll(TOKEN)) allowed.codes.add(m[0].toUpperCase());
  return allowed;
}

export interface NumbersVerdict {
  ok: boolean;
  /** How many numbers were not allowed; never their values. */
  rejected: number;
}

function isoOf(d: number, m: number, y: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function checkNumbers(answer: string, allowed: Allowed): NumbersVerdict {
  let text = latinDigits(answer);
  let rejected = 0;
  text = text.replace(PLACEHOLDER, ' ');
  text = text.replace(CODE, (code) => {
    if (!allowed.codes.has(code)) rejected += 1;
    return ' ';
  });
  text = text.replace(TOKEN, (token) => {
    if (!allowed.codes.has(token.toUpperCase())) rejected += 1;
    return ' ';
  });
  text = text.replace(DATE_ISO, (all) => {
    if (!allowed.dates.has(all)) rejected += 1;
    return ' ';
  });
  text = text.replace(DATE_SLASH, (_all, d: string, m: string, y: string) => {
    if (!allowed.dates.has(isoOf(Number(d), Number(m), Number(y)))) rejected += 1;
    return ' ';
  });
  text = text.replace(TIME, (_all, h: string, mm: string) => {
    if (!allowed.times.has(`${Number(h)}:${mm}`)) rejected += 1;
    return ' ';
  });
  for (const m of text.matchAll(NUMBER)) {
    const whole = canonicalNumber(m[0]);
    if (whole !== null && allowed.quantities.has(whole)) continue;
    // Numbers separated by a space in prose ("3 4") are several: each must be allowed.
    const parts = m[0].split(/[\s  ]+/);
    const each = parts.map((p) => canonicalNumber(p));
    if (parts.length > 1 && each.every((c) => c !== null && allowed.quantities.has(c))) continue;
    rejected += 1;
  }
  return { ok: rejected === 0, rejected };
}
