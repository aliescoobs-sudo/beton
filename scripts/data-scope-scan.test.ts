import { describe, expect, it } from 'vitest';
import { ALLOW, isAllowed, scanRepo, scanSql, scanTs } from './data-scope-scan';

describe('data-scope scan (D249): no national ID, birth date, health or personal address', () => {
  it('flags the forbidden column names in SQL', () => {
    const sql = `create table person (\n  id uuid primary key,\n  cin text,\n  date_of_birth date,\n  health_notes text,\n  home_address text,\n  name text\n);\nalter table x add column national_id text;`;
    const names = scanSql('t.sql', sql).map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(['cin', 'date_of_birth', 'health_notes', 'home_address', 'national_id']),
    );
    expect(names).not.toContain('name');
  });

  it('flags forbidden keys in a seed or fixture', () => {
    const names = scanTs(
      's.ts',
      `const x = { name: 'a', birthDate: '1990-01-01', CIN: 'AB123', ice: '000' };`,
    ).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['birthDate', 'CIN']));
    expect(names).not.toContain('ice');
  });

  it('does not flag the business identifiers (ICE, IF, RC, plate, company phone)', () => {
    const sql = `create table client (\n  ice text,\n  if_number text,\n  rc_number text,\n  plate text,\n  phone_enc text\n);`;
    expect(scanSql('t.sql', sql)).toEqual([]);
  });

  it('every allow-list entry carries a reason', () => {
    for (const [key, reason] of Object.entries(ALLOW)) expect(reason.length, key).toBeGreaterThan(20);
  });

  it('the repository (migrations, pilot seed, importer fixtures) has no blocking finding; allowed ones are exactly the listed exceptions', () => {
    const { all, blocking } = scanRepo();
    expect(blocking.map((f) => `${f.file}:${f.line} ${f.table}.${f.name} [${f.kind}]`)).toEqual([]);
    expect(all.every(isAllowed)).toBe(true);
  });
});
