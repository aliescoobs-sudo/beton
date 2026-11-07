import { describe, expect, it } from 'vitest';
import { importConfirmation, parseArgs, rollbackConfirmation } from './import-excel-lib';

describe('import:excel arguments', () => {
  it('reads each mode with its value and the options', () => {
    expect(parseArgs(['--dry-run', 'book.xlsx'])).toMatchObject({
      mode: 'dry-run',
      target: 'book.xlsx',
      problems: [],
    });
    expect(
      parseArgs([
        '--apply',
        'book.xlsx',
        '--account',
        'a@x.test',
        '--mapping',
        'maps',
        '--opening-date',
        '2026-01-01',
      ]),
    ).toMatchObject({
      mode: 'apply',
      account: 'a@x.test',
      mapping: 'maps',
      openingDate: '2026-01-01',
      problems: [],
    });
    expect(parseArgs(['--rollback', 'run-1', '--account', 'a@x.test'])).toMatchObject({
      mode: 'rollback',
      target: 'run-1',
    });
    expect(parseArgs(['--init-mapping', 'dir'])).toMatchObject({ mode: 'init-mapping', target: 'dir' });
  });
  it('an apply or a rollback must name the account that confirms', () => {
    expect(parseArgs(['--apply', 'b.xlsx']).problems.join()).toMatch(/needs --account/);
    expect(parseArgs(['--rollback', 'r']).problems.join()).toMatch(/needs --account/);
  });
  it('refuses a missing value, an unknown flag, two modes and a date that is not ISO', () => {
    expect(parseArgs(['--dry-run']).problems.join()).toMatch(/needs a value/);
    expect(parseArgs(['--dry-run', 'a', '--mapping']).problems.join()).toMatch(/--mapping needs a value/);
    expect(parseArgs(['--dry-run', 'a', '--force']).problems.join()).toMatch(/unknown argument --force/);
    expect(parseArgs(['--dry-run', 'a', '--apply', 'a']).problems.join()).toMatch(/cannot be combined/);
    expect(parseArgs(['--dry-run', 'a', '--opening-date', '01/01/2026']).problems.join()).toMatch(
      /YYYY-MM-DD/,
    );
    expect(parseArgs([]).problems.join()).toMatch(/choose/);
  });
  it('the typed phrase covers the FULL hash of the file, the mappings and the opening date (Extra 1)', () => {
    const file = 'a'.repeat(64);
    const m = [{ sheet: 'Clients', kind: 'clients', columns: { name: ['Nom'] } }];
    const base = importConfirmation({ fileSha256: file, mappings: m, openingDate: '2026-01-01' });
    expect(base.phrase).toMatch(/^IMPORT [0-9a-f]{64}$/);
    // the key order of a mapping does not matter, a changed value does
    expect(
      importConfirmation({
        fileSha256: file,
        mappings: [{ columns: { name: ['Nom'] }, kind: 'clients', sheet: 'Clients' }],
        openingDate: '2026-01-01',
      }).phrase,
    ).toBe(base.phrase);
    expect(
      importConfirmation({ fileSha256: `b${file.slice(1)}`, mappings: m, openingDate: '2026-01-01' }).phrase,
    ).not.toBe(base.phrase);
    expect(
      importConfirmation({
        fileSha256: file,
        mappings: [{ ...m[0], kind: 'suppliers' }],
        openingDate: '2026-01-01',
      }).phrase,
    ).not.toBe(base.phrase);
    expect(importConfirmation({ fileSha256: file, mappings: m, openingDate: '2026-02-01' }).phrase).not.toBe(
      base.phrase,
    );
    expect(importConfirmation({ fileSha256: file, mappings: m, openingDate: null }).phrase).not.toBe(
      base.phrase,
    );
    // two files that share the first 12 hex digits (the old 48-bit prefix) no longer share a phrase
    expect(
      importConfirmation({
        fileSha256: `${file.slice(0, 12)}${'c'.repeat(52)}`,
        mappings: m,
        openingDate: null,
      }).phrase,
    ).not.toBe(
      importConfirmation({
        fileSha256: `${file.slice(0, 12)}${'d'.repeat(52)}`,
        mappings: m,
        openingDate: null,
      }).phrase,
    );
    expect(rollbackConfirmation('0192f7c0-0000-7000-8000-0123456789ab').phrase).toBe(
      'ROLLBACK 0192f7c0-0000-7000-8000-0123456789ab',
    );
  });
});

import { mkdtempSync, statSync, symlinkSync, readFileSync as readF } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { safeErrorLine, writePrivateReport } from './import-excel-lib';

describe('R14-09: what the CLI prints and stores', () => {
  it('an unexpected error prints a fixed code, never its message', () => {
    const pgError = Object.assign(
      new Error('duplicate key value violates unique constraint; Key (ice)=(999000111222333) already exists'),
      { code: '23505' },
    );
    const line = safeErrorLine(pgError);
    expect(line).toContain('23505');
    expect(line).not.toContain('999000111222333');
    expect(safeErrorLine(new Error('Client Fictif Secret 12 500,00'))).not.toContain('Secret');
    expect(safeErrorLine(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(
      'SYSTEM_ERROR ECONNRESET',
    );
    expect(safeErrorLine('a string with a name')).not.toContain('name');
  });
  it('a report file is 0600 in a 0700 folder, never overwritten, and a linked folder is refused', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'bb-rep-'));
    const dir = path.join(base, 'logs');
    const file = writePrivateReport(dir, 'dry-run', 'TOTAL rows 1', new Date('2026-11-07T08:00:00Z'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readF(file, 'utf8')).toBe('TOTAL rows 1\n');
    expect(() => writePrivateReport(dir, 'dry-run', 'again', new Date('2026-11-07T08:00:00Z'))).toThrow(); // exclusive
    const link = path.join(base, 'link');
    symlinkSync(dir, link);
    expect(() => writePrivateReport(link, 'x', 't', new Date())).toThrow(/link/);
  });
});
