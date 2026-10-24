/**
 * CSV for the accountant and the owner (DECISIONS 82): UTF-8 with a byte-order mark so that Excel reads the accents,
 * `;` as the separator and a decimal comma as French locales expect, every cell quoted when it needs it, and no cell that
 * a spreadsheet could take for a formula (a leading = + - @ tab or carriage return is neutralised with an apostrophe).
 * Numbers go through `num()`, which is the one way a leading minus is allowed: a typed number, never free text.
 */
export type CsvCell = string | { num: string };

export const num = (formatted: string): CsvCell => ({ num: formatted });

const FORMULA = /^[=+\-@\t\r]/;

function cell(value: CsvCell): string {
  const text = typeof value === 'string' ? (FORMULA.test(value) ? `'${value}` : value) : value.num;
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return `﻿${rows.map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`;
}
