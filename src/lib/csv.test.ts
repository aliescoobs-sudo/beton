import { describe, expect, it } from 'vitest';
import { num, toCsv } from './csv';

describe('toCsv', () => {
  it('starts with a byte-order mark, separates with ; and ends each line with CRLF', () => {
    expect(
      toCsv([
        ['a', 'b'],
        ['c', num('1 234,50')],
      ]),
    ).toBe('﻿a;b\r\nc;1 234,50\r\n');
  });

  it('quotes cells holding ;, quotes or line breaks, doubling the quotes', () => {
    expect(toCsv([['x;y', 'say "hi"', 'two\nlines']])).toBe('﻿"x;y";"say ""hi""";"two\nlines"\r\n');
  });

  it('neutralises anything a spreadsheet would run as a formula, but not a typed negative number', () => {
    const csv = toCsv([['=SUM(A1)', '+1', '-1', '@x', '\tx', 'ok', num('-120,00')]]);
    expect(csv).toBe("﻿'=SUM(A1);'+1;'-1;'@x;'\tx;ok;-120,00\r\n");
  });
});
