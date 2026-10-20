import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 🟡 D57 / AC-MD-01: no national-ID-card field anywhere in master data: schema, code or messages.
describe('no CIN in master data', () => {
  const files = [
    ...globSync('db/migrations/*.sql'),
    ...globSync('src/modules/master-data/**/*.{ts,tsx}'),
    ...globSync('src/app/\\[locale\\]/(protected)/master-data/**/*.tsx'),
    'messages/fr.json',
    'messages/ar.json',
  ];

  it('scans something', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)('%s', (file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(/\bCIN\b|carte nationale|بطاقة التعريف/i);
  });
});
