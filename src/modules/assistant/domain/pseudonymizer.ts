import { formatCentimes, parseCentimes } from '@/lib/money';
import { err, ok, type Result } from '@/lib/result';
import { findRuns, latinDigits, nameWords, tokenize } from './normalize';

/** A person or company the question may name, by its code. The names are what a person might type; the first is shown. */
export interface EntityRef {
  code: string;
  names: string[];
}

const ENTITY_CODE = /\b(?:CLT|FRN)-\d{1,6}\b/g;

const AMOUNT =
  /(?<![\d.,])([\d٠-٩۰-۹]{1,3}(?:[  .][\d٠-٩۰-۹]{3})+|[\d٠-٩۰-۹]+)(?:[.,]([\d٠-٩۰-۹]{1,2}))?\s*(?:mad|dhs?|dirhams?|درهم|دراهم|د\.م\.?)(?![\p{L}])/giu;
const PHONE = /(?:\+|00)?212[\s.-]?[5-7](?:[\s.-]?\d){8}|(?<!\d)0[5-7](?:[\s.-]?\d){8}(?!\d)/g;
const LONG_NUMBER = /(?<![\d{])\d{6,}(?![\d}])/g;

const PLACEHOLDER = /\{\{(AMT|NUM)_(\d+)\}\}/g;

export type HydrateError = 'UNKNOWN_PLACEHOLDER';

/**
 * Everything that stands between a person and the model for one turn (SPEC-assistant §4). It lives in the memory of the request
 * and nowhere else: the mapping code ↔ entity, placeholder ↔ amount. The question is masked (amounts, phones, ICE, long numbers,
 * known names), tool results get their amounts replaced by placeholders, and the answer is given back its real values by code.
 */
export class Pseudonymizer {
  private readonly userAmounts = new Map<string, number | null>();
  private readonly toolAmounts = new Map<string, number>();
  private readonly numbers = new Map<string, string>();
  private counter = 0;
  private readonly entities: { words: string[]; code: string }[];
  private readonly shown = new Map<string, string>();
  private readonly byName = new Map<string, string>();

  constructor(entities: readonly EntityRef[]) {
    for (const e of entities) {
      if (e.names[0]) this.shown.set(e.code, e.names[0]);
      for (const n of e.names) this.byName.set(nameWords(n).join(' '), e.code);
    }
    // Longest names first, so "Béton Atlas Sud" wins over "Atlas".
    this.entities = entities
      .flatMap((e) => e.names.map((n) => ({ words: nameWords(n), code: e.code })))
      .filter((e) => e.words.join('').length >= 3)
      .sort((a, b) => b.words.length - a.words.length);
  }

  private next(kind: 'AMT' | 'NUM'): string {
    this.counter += 1;
    return `{{${kind}_${this.counter}}}`;
  }

  /** The question as the model may see it. Amounts and numbers typed by the person are kept here, to give to a draft. */
  maskQuestion(text: string): string {
    let out = text.normalize('NFC');
    out = out.replace(AMOUNT, (_all, whole: string, decimals: string | undefined) => {
      const placeholder = this.next('AMT');
      const digits = latinDigits(whole).replace(/[\s.  ]/g, '');
      const parsed = parseCentimes(decimals ? `${digits},${latinDigits(decimals)}` : digits);
      this.userAmounts.set(placeholder, parsed);
      return placeholder;
    });
    out = out.replace(PHONE, (value) => this.hold(value));
    out = out.replace(LONG_NUMBER, (value) => this.hold(value));
    return this.namesToCodes(out);
  }

  private hold(value: string): string {
    const placeholder = this.next('NUM');
    this.numbers.set(placeholder, value);
    return placeholder;
  }

  private namesToCodes(text: string): string {
    const tokens = tokenize(text);
    const taken = new Array<boolean>(tokens.length).fill(false);
    const spans: { start: number; end: number; code: string }[] = [];
    for (const entity of this.entities) {
      for (const run of findRuns(tokens, entity.words)) {
        let free = true;
        for (let i = run.from; i <= run.to; i += 1) if (taken[i]) free = false;
        if (!free) continue;
        for (let i = run.from; i <= run.to; i += 1) taken[i] = true;
        spans.push({ start: tokens[run.from]!.start, end: tokens[run.to]!.end, code: entity.code });
      }
    }
    let out = text;
    for (const span of spans.sort((a, b) => b.start - a.start)) {
      out = `${out.slice(0, span.start)}${span.code}${out.slice(span.end)}`;
    }
    return out;
  }

  /** The code of a client or supplier by the name a screen shows, or null when it is not one this person may see. */
  codeOfName(name: string): string | null {
    return this.byName.get(nameWords(name).join(' ')) ?? null;
  }

  /** Codes of the entities this person may read, back to the names the screens show; other codes stay codes. */
  showNames(text: string): string {
    return text.replace(ENTITY_CODE, (code) => this.shown.get(code) ?? code);
  }

  /** The placeholder that stands for an amount a tool returned. The model never sees the figure. */
  amount(centimes: number): string {
    const placeholder = this.next('AMT');
    this.toolAmounts.set(placeholder, centimes);
    return placeholder;
  }

  /** What the person typed behind a placeholder of their question: centimes, or null when it could not be read as an amount. */
  userAmount(placeholder: string): number | null | undefined {
    return this.userAmounts.get(placeholder);
  }

  /** The number (cheque, phone…) the person typed behind a placeholder, for a draft only. */
  userNumber(placeholder: string): string | undefined {
    return this.numbers.get(placeholder);
  }

  /** The real values back in an answer, by code: the amount is the stored centimes formatted by the screens' own function. */
  hydrate(text: string): Result<string, HydrateError> {
    let unknown = false;
    const out = text.replace(PLACEHOLDER, (all, kind: string) => {
      const value =
        kind === 'AMT'
          ? (this.toolAmounts.get(all) ?? this.userAmounts.get(all) ?? null)
          : (this.numbers.get(all) ?? null);
      if (value === null || value === undefined) {
        unknown = true;
        return all;
      }
      return typeof value === 'number' ? `${formatCentimes(value)} MAD` : value;
    });
    return unknown ? err('UNKNOWN_PLACEHOLDER') : ok(out);
  }

  /** The amounts of tool results, for tests: placeholder → centimes. */
  toolAmountsForTest(): ReadonlyMap<string, number> {
    return this.toolAmounts;
  }
}

export const PLACEHOLDER_PATTERN = PLACEHOLDER;
