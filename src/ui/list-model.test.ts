import { describe, expect, it } from 'vitest';
import { hrefWith, paginate, parseSort, sortRows } from './list-model';

describe('parseSort', () => {
  it('accepts only declared columns and falls back otherwise', () => {
    expect(parseSort({ sort: 'total', dir: 'desc' }, ['code', 'total'])).toEqual({
      key: 'total',
      dir: 'desc',
    });
    expect(parseSort({ sort: 'DROP TABLE' }, ['code'])).toBeNull();
    expect(parseSort({ sort: 'x' }, ['code'], { key: 'code', dir: 'desc' })).toEqual({
      key: 'code',
      dir: 'desc',
    });
    expect(parseSort({ sort: ['code', 'total'], dir: 'sideways' }, ['code'])).toEqual({
      key: 'code',
      dir: 'asc',
    });
  });
});

describe('sortRows', () => {
  const rows = [
    { n: 'CMD-10', v: 5 },
    { n: 'CMD-2', v: null },
    { n: 'CMD-1', v: 9 },
  ];
  const acc = { n: (r: (typeof rows)[number]) => r.n, v: (r: (typeof rows)[number]) => r.v };
  it('sorts numbers numerically and text naturally, leaving the input alone', () => {
    expect(sortRows(rows, { key: 'n', dir: 'asc' }, acc).map((r) => r.n)).toEqual([
      'CMD-1',
      'CMD-2',
      'CMD-10',
    ]);
    expect(rows[0]!.n).toBe('CMD-10');
  });
  it('puts empty values last in both directions', () => {
    expect(sortRows(rows, { key: 'v', dir: 'asc' }, acc).map((r) => r.v)).toEqual([5, 9, null]);
    expect(sortRows(rows, { key: 'v', dir: 'desc' }, acc).map((r) => r.v)).toEqual([9, 5, null]);
  });
  it('keeps the order for an unknown column or no sort', () => {
    expect(sortRows(rows, null, acc)).toEqual(rows);
    expect(sortRows(rows, { key: 'zz', dir: 'asc' }, acc)).toEqual(rows);
  });
});

describe('paginate', () => {
  const rows = Array.from({ length: 60 }, (_, i) => i);
  it('slices and clamps the page', () => {
    expect(paginate(rows, { page: '2' }, 25)).toMatchObject({ page: 2, pages: 3, from: 26, to: 50 });
    expect(paginate(rows, { page: '99' }, 25)).toMatchObject({ page: 3, from: 51, to: 60 });
    expect(paginate(rows, { page: 'abc' }, 25).page).toBe(1);
    expect(paginate([], {}, 25)).toMatchObject({ total: 0, pages: 1, from: 0, to: 0 });
  });
});

describe('hrefWith', () => {
  it('keeps filters, replaces one, drops empties and resets the page', () => {
    expect(hrefWith('/fr/orders', { state: 'late', page: '3', q: '' }, { sort: 'code', dir: 'asc' })).toBe(
      '/fr/orders?state=late&sort=code&dir=asc',
    );
    expect(hrefWith('/fr/orders', { state: 'late' }, { state: null })).toBe('/fr/orders');
    expect(hrefWith('/fr/orders', {}, { page: 2 })).toBe('/fr/orders?page=2');
  });
});

import { readFileSync } from 'node:fs';
describe('CSP', () => {
  it('the list kit and error state set no inline style attribute (style-src has no unsafe-inline)', () => {
    for (const f of ['src/ui/list-kit.tsx', 'src/ui/error-state.tsx', 'src/app/shell/bottom-bar.tsx'])
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/\bstyle=\{/);
  });
});
