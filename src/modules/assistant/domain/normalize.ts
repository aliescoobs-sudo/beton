/** Digits of every script the people here type in (Latin, Arabic-Indic, Eastern Arabic-Indic) as Latin digits. */
export function latinDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * One form for names typed in Latin or Arabic letters: accents and Arabic diacritics removed, the alef, yeh and teh-marbuta
 * variants unified, lower case. Words only: no punctuation, no digits are dropped.
 */
export function normalizeWord(word: string): string {
  return latinDigits(word)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase();
}

export interface Token {
  /** The normalized word. */
  word: string;
  start: number;
  end: number;
}

/** The words (letters and digits) of a text with their place in it. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const word = normalizeWord(m[0]);
    if (word) out.push({ word, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function nameWords(name: string): string[] {
  return tokenize(name).map((t) => t.word);
}

/** Positions where `words` appears as a run of consecutive tokens. */
export function findRuns(tokens: readonly Token[], words: readonly string[]): { from: number; to: number }[] {
  const found: { from: number; to: number }[] = [];
  if (words.length === 0) return found;
  for (let i = 0; i + words.length <= tokens.length; i += 1) {
    if (words.every((w, j) => tokens[i + j]?.word === w)) found.push({ from: i, to: i + words.length - 1 });
  }
  return found;
}
