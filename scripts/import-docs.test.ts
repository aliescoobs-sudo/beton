import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COLUMNS } from '../src/modules/importer/service/importers';
import { DEFAULT_SHEET_NAMES } from '../src/modules/importer/service/mapping-files';

// docs/IMPORT-EXCEL.md is how the office adapts the import to the real headers: it must name every kind, field and default sheet the
// code knows, so the page cannot drift from the importer.
const doc = readFileSync('docs/IMPORT-EXCEL.md', 'utf8');

describe('docs/IMPORT-EXCEL.md', () => {
  it('names every kind, every field of every kind and every default sheet', () => {
    for (const [kind, fields] of Object.entries(COLUMNS)) {
      expect(doc, `kind ${kind}`).toContain(kind);
      for (const field of Object.keys(fields)) expect(doc, `${kind}.${field}`).toContain(`\`${field}`);
    }
    for (const sheet of Object.values(DEFAULT_SHEET_NAMES)) expect(doc, `sheet ${sheet}`).toContain(sheet);
  });
  it('documents the commands and the mapping keys', () => {
    for (const word of [
      '--dry-run',
      '--apply',
      '--rollback',
      '--init-mapping',
      '--mapping',
      '--account',
      'headerRow',
      'dateFormat',
      'defaultPlant',
    ])
      expect(doc, word).toContain(word);
  });
  it('keeps real data out: no file name of the company, only synthetic markers', () => {
    expect(doc).toMatch(/synthetic/i);
    expect(doc).not.toMatch(/BELGOBETON-data/);
  });
});
