/**
 * The pure part of the shared list pattern (T18-UI C): sort, page and link building from URL search params. No React, no I/O, so it is
 * unit-tested. A list screen keeps its own server-side permission checks and its own data; this only orders and slices what it already has.
 */
export type SortDir = 'asc' | 'desc';
export type SearchParams = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** The sort asked for in `?sort=&dir=`, only when the column is one the screen declared (anything else is ignored, never trusted). */
export function parseSort(
  q: SearchParams,
  allowed: readonly string[],
  fallback?: { key: string; dir: SortDir },
): { key: string; dir: SortDir } | null {
  const key = one(q.sort);
  if (key && allowed.includes(key)) return { key, dir: one(q.dir) === 'desc' ? 'desc' : 'asc' };
  return fallback ?? null;
}

type Cell = string | number | null | undefined;

/** A stable, locale-aware sort (numbers numerically, empty values last in both directions). Returns a new array. */
export function sortRows<T>(
  rows: readonly T[],
  sort: { key: string; dir: SortDir } | null,
  accessors: Record<string, (row: T) => Cell>,
): T[] {
  const get = sort ? accessors[sort.key] : undefined;
  if (!sort || !get) return [...rows];
  const sign = sort.dir === 'desc' ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, value: get(row) }))
    .sort((a, b) => {
      const ae = a.value === null || a.value === undefined || a.value === '';
      const be = b.value === null || b.value === undefined || b.value === '';
      if (ae || be) return ae === be ? a.index - b.index : ae ? 1 : -1;
      const cmp =
        typeof a.value === 'number' && typeof b.value === 'number'
          ? a.value - b.value
          : String(a.value).localeCompare(String(b.value), 'fr', { numeric: true, sensitivity: 'base' });
      return cmp !== 0 ? sign * cmp : a.index - b.index;
    })
    .map((x) => x.row);
}

export const PAGE_SIZE = 25;

export interface Page<T> {
  rows: T[];
  page: number;
  pages: number;
  total: number;
  /** 1-based position of the first and last row shown (0 and 0 when the list is empty). */
  from: number;
  to: number;
}

/** The page asked for in `?page=` (clamped to what exists) and its slice. */
export function paginate<T>(rows: readonly T[], q: SearchParams, size = PAGE_SIZE): Page<T> {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const asked = Number.parseInt(one(q.page) ?? '1', 10);
  const page = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), pages) : 1;
  const start = (page - 1) * size;
  const slice = rows.slice(start, start + size);
  return { rows: slice, page, pages, total, from: total === 0 ? 0 : start + 1, to: start + slice.length };
}

/** The same screen with some params replaced (`null` removes one). Other filters are kept; the page goes back to 1 unless given. */
export function hrefWith(
  path: string,
  q: SearchParams,
  changes: Record<string, string | number | null>,
): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    const s = one(v);
    if (s !== undefined && s !== '') next.set(k, s);
  }
  if (!('page' in changes)) next.delete('page');
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === '') next.delete(k);
    else next.set(k, String(v));
  }
  const s = next.toString();
  return s ? `${path}?${s}` : path;
}
