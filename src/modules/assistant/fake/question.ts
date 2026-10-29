import { normalizeWord, tokenize } from '../domain/normalize';

/** A masked question, read once: its words in one normal form, and the codes, references and quantities it carries. */
export interface Q {
  text: string;
  /** The words, normalized (accents and Arabic diacritics removed), joined by one space, with a space at each end. */
  norm: string;
  has(...words: string[]): boolean;
  clients: string[];
  suppliers: string[];
  sites: string[];
  bls: string[];
  orders: string[];
  pos: string[];
  /** Any document-like number: BL-, FA-, FF-, AV-, DV-, ACH-, CMD-. */
  documents: string[];
  amounts: string[];
  numbers: string[];
  types: string[];
  /** A quantity in m³ ("20 m³", "7,5 m3", "٢٠ م³"). */
  m3: number | null;
  /** A quantity in tonnes. */
  tonnes: number | null;
  isoDates: string[];
  month: string | null;
}

const find = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((m) => m[0]);

const number = (raw: string): number => Number(raw.replace(',', '.'));

export function readQuestion(text: string): Q {
  const norm = ` ${tokenize(text)
    .map((t) => t.word)
    .join(' ')} `;
  const latin = text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const m3 = /(\d+(?:[.,]\d+)?)\s*(?:m3|m³|م3|م³|metres? cubes?|متر)/i.exec(latin);
  const tonnes = /(\d+(?:[.,]\d+)?)\s*(?:t|tonnes?|طن)(?![\p{L}\d])/iu.exec(latin);
  return {
    text,
    norm,
    // A short word (bl, 50, cash) must be a word of its own; a longer one may be a part of a word (facturé, facturer).
    has: (...words) =>
      words.some((w) => {
        const n = normalizeWord(w);
        return n.length <= 3 ? norm.includes(` ${n} `) : norm.includes(n);
      }),
    clients: find(text, /\bCLT-\d{1,6}\b/g),
    suppliers: find(text, /\bFRN-\d{1,6}\b/g),
    sites: find(text, /\bSITE-\d{1,6}-\d{1,3}\b/g),
    bls: find(text, /\bBL-\d{4}-\d{5,}\b/g),
    orders: find(text, /\bCMD-\d{4}-\d{5,}\b/g),
    pos: find(text, /\bACH-\d{4}-\d{5,}\b/g),
    documents: find(text, /\b(?:BL|FA|FF|AV|DV|ACH|CMD)-\d{4}-\d{3,}\b/g),
    amounts: find(text, /\{\{AMT_\d+\}\}/g),
    numbers: find(text, /\{\{NUM_\d+\}\}/g),
    types: find(text, /\bB\d{2}\b/g),
    m3: m3 ? number(m3[1] as string) : null,
    tonnes: tonnes ? number(tonnes[1] as string) : null,
    isoDates: find(text, /\b\d{4}-\d{2}-\d{2}\b/g),
    month: /\b(\d{4}-(?:0[1-9]|1[0-2]))\b(?!-)/.exec(text)?.[1] ?? null,
  };
}
