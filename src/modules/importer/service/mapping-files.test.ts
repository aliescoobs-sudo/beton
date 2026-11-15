import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultMappings, loadMappingFiles, writeDefaultMappingFiles } from './mapping-files';

mkdirSync('.logs', { recursive: true });
const dir = mkdtempSync(join('.logs', 'map-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const put = (name: string, content: unknown) => {
  const f = join(dir, name);
  writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
  return f;
};

describe('mapping files', () => {
  it('the built-in defaults cover every kind once, with distinct sheet names', () => {
    const d = defaultMappings();
    expect(d).toHaveLength(17);
    expect(new Set(d.map((m) => m.sheet)).size).toBe(17);
    expect(new Set(d.map((m) => m.kind)).size).toBe(17);
  });
  it('writes the defaults as editable files, and what it wrote loads back unchanged', () => {
    const out = join(dir, 'written');
    const { written } = writeDefaultMappingFiles(out);
    expect(written).toHaveLength(17);
    const back = loadMappingFiles(out);
    expect(back.problems).toEqual([]);
    expect(back.mappings.map((m) => m.kind).sort()).toEqual(
      defaultMappings()
        .map((m) => m.kind)
        .sort(),
    );
    const clients = JSON.parse(readFileSync(join(out, 'clients.json'), 'utf8'));
    expect(clients.columns.name).toContain('raison sociale');
    // a second call keeps the person's edits
    writeFileSync(join(out, 'clients.json'), '{"edited":true}');
    expect(writeDefaultMappingFiles(out).skipped).toHaveLength(17);
    expect(readFileSync(join(out, 'clients.json'), 'utf8')).toBe('{"edited":true}');
  });
  it('names the file and the problem; a missing path, a typo in a field and a sheet named twice are refused', () => {
    expect(loadMappingFiles(join(dir, 'nothing-here')).problems[0]).toMatch(/not found/);
    const bad = join(dir, 'bad');
    mkdirSync(bad);
    writeFileSync(
      join(bad, 'a.json'),
      JSON.stringify({ version: 1, sheet: 'A', kind: 'clients', columns: { nmae: 'x' } }),
    );
    writeFileSync(join(bad, 'b.json'), JSON.stringify({ version: 1, sheet: 'Dup', kind: 'clients' }));
    writeFileSync(join(bad, 'c.json'), JSON.stringify({ version: 1, sheet: 'dup', kind: 'suppliers' }));
    const r = loadMappingFiles(bad);
    expect(r.problems.join('\n')).toMatch(/a\.json: columns\.nmae/);
    expect(r.problems.join('\n')).toMatch(/two mapping files name the sheet "dup"/i);
    expect(put('one.json', '{').length).toBeGreaterThan(0);
    expect(loadMappingFiles(join(dir, 'one.json')).problems[0]).toMatch(/not valid JSON/);
  });
});
