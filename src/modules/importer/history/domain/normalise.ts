// T11: the normalisers of the history importer. Pure functions, no database, no model. A label is turned into a KEY (what two spellings of the
// same thing share); the key is what the owner decides on in staging. Nothing here merges two different keys: that is the owner's decision.

/** Upper case, no accents, every run of anything but letters and digits is one space. */
export function foldKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9؀-ۿ]+/g, ' ')
    .trim();
}

/** Client: the folded name ("Name  1" and "NAME 1" are one key; "NAME" and "NAME 1" are two, grouped by similarity on the screen). */
export const clientKey = (text: string): string => foldKey(text);

/** Truck: spaces, dashes and case do not matter ("12345-A-6", "12345 a 6"); a numeric internal code is its own key. */
export const truckKey = (text: string): string => foldKey(text).replace(/ /g, '');

/** Driver: the folded name. */
export const driverKey = (text: string): string => foldKey(text);

/** Concrete type: "B25 ", "B 25", "b25" are one key, B25. */
export const typeKey = (text: string): string => foldKey(text).replace(/ /g, '');

export type PumpMode = 'pump' | 'chute' | 'unknown';
/** The built-in pump alias table (the owner's edits live in the label map). Keys are folded. A label not here goes to staging. */
export const BUILTIN_PUMP_ALIASES: Readonly<Record<string, PumpMode>> = {
  POMPE: 'pump',
  P: 'pump',
  GOULOTTE: 'chute',
  G: 'chute',
};
export const pumpKey = (text: string): string => foldKey(text);

export const CATEGORY_CODES = ['fuel', 'parts', 'tyres', 'wages_advance', 'office', 'other'] as const;
export type CategoryCode = (typeof CATEGORY_CODES)[number];
/** The built-in expense category table: folded imputation text (litres and numbers removed) to a category. Anything else goes to staging. */
export const BUILTIN_CATEGORY_ALIASES: Readonly<Record<string, CategoryCode>> = {
  GASOIL: 'fuel',
  GAZOIL: 'fuel',
  CARBURANT: 'fuel',
  DIESEL: 'fuel',
  PIECES: 'parts',
  PIECE: 'parts',
  'PIECES DE RECHANGE': 'parts',
  FILTRE: 'parts',
  FILTRES: 'parts',
  PNEU: 'tyres',
  PNEUS: 'tyres',
  AVANCE: 'wages_advance',
  'AVANCE SALAIRE': 'wages_advance',
  ACOMPTE: 'wages_advance',
  BUREAU: 'office',
  PAPETERIE: 'office',
  TELEPHONE: 'office',
};

const LITRES = /(\d{1,6}(?:[.,]\d{1,3})?)\s*(?:L|LT|LTS|LITRE|LITRES)(?![A-Za-z])/i;

/** Litres written in a text ("GASOIL 84,22 L") as integer millilitres, or null. No float is used. */
export function litresInText(text: string): number | null {
  const m = LITRES.exec(text);
  if (!m) return null;
  const [whole = '0', frac = ''] = (m[1] as string).replace(',', '.').split('.');
  const ml = Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
  return ml > 0 ? ml : null;
}

/** The category key of an imputation: the text without its litres and without digits. "GASOIL 84,22 L" and "Gasoil" are one key. */
export function categoryKey(text: string): string {
  return foldKey(text.replace(new RegExp(LITRES.source, 'gi'), ' ').replace(/[0-9]+/g, ' '));
}

/** HT / TTC from a cell: only the exact words (any case, dots and spaces ignored); anything else is null. */
export function taxBasisOf(text: string): 'HT' | 'TTC' | null {
  const k = foldKey(text).replace(/ /g, '');
  return k === 'HT' ? 'HT' : k === 'TTC' ? 'TTC' : null;
}

/** The tax basis of a row: its HT/T cell; when that is empty and ADJUVANT is exactly HT or TTC, from there; otherwise null. */
export function taxBasisOfRow(htT: string, adjuvant: string): 'HT' | 'TTC' | null {
  return taxBasisOf(htT) ?? (htT.trim() === '' ? taxBasisOf(adjuvant) : null);
}

export type VolumeParse = { ok: true; litres: number } | { ok: false; reason: 'NO_VOLUME' | 'BAD_VOLUME' };
const MAX_LITRES = 200_000_000;

/**
 * A quantity in m³ as integer litres. At most three decimals; a spreadsheet's float residue ("7.2000000000000002", "7.4999999999999991") is
 * rounded only when the extra digits are a run of zeros or of nines; anything else ("7.25 m3 and a half", "-3", "0", text) is refused.
 */
export function parseVolumeM3(text: string): VolumeParse {
  const t = text.replace(/[\s  ]/g, '');
  if (t === '') return { ok: false, reason: 'NO_VOLUME' };
  const m = /^(\d{1,6})(?:[.,](\d+))?$/.exec(t);
  if (!m) return { ok: false, reason: 'BAD_VOLUME' };
  let litres = Number(m[1]) * 1000;
  const frac = m[2] ?? '';
  litres += Number(frac.slice(0, 3).padEnd(3, '0'));
  const tail = frac.slice(3);
  if (tail !== '') {
    if (/^0+$/.test(tail) || /^0{3,}/.test(tail)) {
      /* residue below the thousandth: floor */
    } else if (/^9{3,}/.test(tail)) litres += 1;
    else return { ok: false, reason: 'BAD_VOLUME' };
  }
  return litres > 0 && litres <= MAX_LITRES ? { ok: true, litres } : { ok: false, reason: 'BAD_VOLUME' };
}

/** A delivery note value larger than this is garbage left by a conversion, not a number of the book: kept raw, flagged suspect. */
export const BL_SUSPECT_ABOVE = 1_000_000;
export function blNumber(raw: string): number | null {
  const m = /^(\d{1,15})(?:[.,]0+)?$/.exec(raw.trim());
  return m ? Number(m[1]) : null;
}
export const blSuspect = (raw: string): boolean => {
  const n = blNumber(raw);
  return n !== null && n > BL_SUSPECT_ABOVE;
};

/** Similarity groups for the client screen: names that differ only by trailing digits, word order, or one edit. Suggestions, never merges. */
export function similarityGroups(keys: readonly string[]): string[][] {
  const stem = (k: string) =>
    k
      .replace(/\s+\d+$/, '')
      .split(' ')
      .sort()
      .join(' ');
  const parent = new Map<string, string>(keys.map((k) => [k, k]));
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(k, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const byStem = new Map<string, string>();
  for (const k of keys) {
    const s = stem(k);
    const other = byStem.get(s);
    if (other) union(k, other);
    else byStem.set(s, k);
  }
  const stems = [...byStem.keys()];
  for (let i = 0; i < stems.length; i++)
    for (let j = i + 1; j < stems.length; j++)
      if (withinOneEdit(stems[i] as string, stems[j] as string))
        union(byStem.get(stems[i] as string) as string, byStem.get(stems[j] as string) as string);
  const groups = new Map<string, string[]>();
  for (const k of keys) groups.set(find(k), [...(groups.get(find(k)) ?? []), k]);
  return [...groups.values()].filter((g) => g.length > 1);
}

/** True when two strings of at least five letters differ by one insertion, deletion or substitution. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}
