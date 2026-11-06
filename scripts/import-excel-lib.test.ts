import { describe, expect, it } from 'vitest';
import { confirmationPhrase, parseArgs, rollbackPhrase } from './import-excel-lib';

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
  it('the typed phrase is tied to the file (or the run), so it cannot be reused for another one', () => {
    const a = 'a'.repeat(64);
    const b = `b${'a'.repeat(63)}`;
    expect(confirmationPhrase(a)).toBe('IMPORT aaaaaaaaaaaa');
    expect(confirmationPhrase(a)).not.toBe(confirmationPhrase(b));
    expect(rollbackPhrase('0192f7c0-0000-7000-8000-0123456789ab')).toBe('ROLLBACK 0123456789ab');
  });
});
