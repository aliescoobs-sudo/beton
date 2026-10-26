import { findRuns, latinDigits, nameWords, tokenize } from './normalize';

/** What must never appear in an outbound payload (SPEC-assistant §4): every name, phone, ICE, instrument number, bank and plate we hold. */
export interface LeakIndex {
  /** Names of clients, suppliers, users, drivers, banks; plates. Each is compared as normalized words. */
  names: string[];
  /** Phones, ICE, cheque and LCN numbers, as digits and letters. */
  numbers: string[];
}

export type LeakKind = 'name' | 'number' | 'phone_shape' | 'ice_shape' | 'long_number' | 'amount_shape';

export interface LeakHit {
  kind: LeakKind;
}

const SHAPES: { kind: LeakKind; pattern: RegExp }[] = [
  {
    kind: 'phone_shape',
    pattern: /(?:\+|00)?212[\s.-]?[5-7](?:[\s.-]?\d){8}|(?<!\d)0[5-7](?:[\s.-]?\d){8}(?!\d)/,
  },
  { kind: 'ice_shape', pattern: /(?<!\d)\d{15}(?!\d)/ },
  // Any run of six digits or more: a cheque or LCN number, a phone without its shape, a bank account. Codes have shorter runs.
  { kind: 'long_number', pattern: /(?<![\d{])\d{6,}(?![\d}])/ },
  { kind: 'amount_shape', pattern: /\d[\d  .,]*\s?(?:mad|dhs?|dirhams?|درهم|دراهم)(?![\p{L}])/iu },
];

function compact(value: string): string {
  return latinDigits(value)
    .replace(/[\s.\-_/]/g, '')
    .toLowerCase();
}

/**
 * Looks for what must not leave in a payload that is about to be sent (question, history, tool results). Returns the kinds of
 * what it found and never the values, so a log of a blocked call carries no personal data. Names are matched as normalized words
 * (Latin and Arabic forms), numbers as digit runs whatever the separators.
 */
export function scanForLeaks(payload: string, index: LeakIndex): LeakHit[] {
  const hits: LeakHit[] = [];
  const text = latinDigits(payload);

  const tokens = tokenize(text);
  for (const name of index.names) {
    const words = nameWords(name);
    if (words.join('').length < 3) continue;
    if (findRuns(tokens, words).length > 0) {
      hits.push({ kind: 'name' });
      break;
    }
  }

  if (index.numbers.length > 0) {
    const runs = [...text.matchAll(/[+\d][\dA-Za-z \-./]{3,}/g)].map((m) => compact(m[0]));
    const wanted = index.numbers.map(compact).filter((n) => n.length >= 4);
    if (runs.some((run) => wanted.some((n) => run.includes(n)))) hits.push({ kind: 'number' });
  }

  for (const shape of SHAPES) if (shape.pattern.test(text)) hits.push({ kind: shape.kind });
  return hits;
}
