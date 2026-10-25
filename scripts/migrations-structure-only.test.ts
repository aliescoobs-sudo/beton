import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Decision 79: migrations create structure only. Fake data and still-assumed reference values (zones, components,
// concrete types...) come from the pilot seed, which runs after RLS and the audit triggers exist and refuses
// REAL_DATA. This guard reads the migration SQL; a seed hidden in a migration would skip the audit log.
const FOLDER = 'db/migrations';

/** Statement text outside comments and `$$ … $$` function bodies (functions may insert when *called*). */
function topLevelSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\$\$[\s\S]*?\$\$/g, '$$$$')
    .replace(/\s+/g, ' ');
}

const files = readdirSync(FOLDER).filter((f) => f.endsWith('.sql'));

/**
 * Conversions of rows that already exist when a table changes shape (review of CP-OPS-1-3). They create no seed and no
 * business fact: each row is derived from rows the application already wrote, they run as the system actor so the audit
 * trigger records them, and nothing here relaxes RLS or auditing (still checked below). Adding to this list is a decision.
 */
const CONVERSIONS: Record<string, string> = {
  '0053_partial_receipts.sql':
    'one receipt line per stocked purchase line of each existing receipt (the old receipt took everything)',
  '0055_thresholds_one_source.sql':
    'component.low_stock_threshold values copied into stock_threshold before the column is dropped',
};

describe('migrations create structure only (decision 79)', () => {
  it('finds the migrations', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)('%s inserts no business rows and never relaxes RLS or auditing', (file) => {
    const sql = topLevelSql(readFileSync(`${FOLDER}/${file}`, 'utf8'));
    if (!(file in CONVERSIONS))
      expect(sql, 'INSERT/COPY/UPDATE/DELETE at migration level').not.toMatch(
        /\b(insert\s+into|copy\s|delete\s+from|update\s+\S+\s+set)\b/i,
      );
    else expect(sql, 'a conversion never deletes or copies out').not.toMatch(/\b(copy\s|delete\s+from)\b/i);
    expect(sql, 'RLS or audit switched off').not.toMatch(
      /no\s+force\s+row\s+level|disable\s+row\s+level|disable\s+trigger/i,
    );
  });

  it('would catch a seed (self-test of the scanner)', () => {
    const sneaky = topLevelSql(
      `CREATE TABLE t (a int); -- ok\nINSERT INTO t VALUES (1);\nCREATE FUNCTION f() ... $$ INSERT INTO t VALUES (2) $$;`,
    );
    expect(sneaky.match(/\binsert\s+into\b/gi)).toHaveLength(1);
  });
});
