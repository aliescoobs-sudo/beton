import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AC-MD-06 (UI and service part; the DB part is the table-access meta-test): master data is archived or versioned,
// never deleted. No master-data screen, action or service offers a delete, and no master-data message says "delete".
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

const code = [...files('src/modules/master-data'), ...files('src/app/[locale]/(protected)/master-data')];

describe('no delete in master data (AC-MD-06)', () => {
  it('finds the master-data code', () => {
    expect(code.length).toBeGreaterThan(40);
  });

  it.each(code)('%s has no delete function, form or call', (file) => {
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    expect(source).not.toMatch(/\bdelete[A-Z]\w*|\bremove[A-Z]\w*|\bdestroy\w*/);
    expect(source).not.toMatch(/\bdelete\s+from\b|\btruncate\s+/i);
    expect(source).not.toMatch(/method:\s*['"]DELETE['"]/);
  });

  it('master-data messages offer no delete wording in fr or ar', () => {
    for (const locale of ['fr', 'ar']) {
      const { masterData } = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as {
        masterData: object;
      };
      const text = JSON.stringify(masterData);
      expect(text, locale).not.toMatch(/supprim|effac|delete|remove|حذف|مسح|إزالة/i);
    }
  });
});
