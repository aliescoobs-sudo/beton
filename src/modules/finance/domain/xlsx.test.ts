import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { accountantWorkbook } from '../service/accountant-export';
import { xlsx } from './xlsx';
function inspect(bytes: Buffer) {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `import io,sys,zipfile,json,xml.etree.ElementTree as E
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert z.testzip() is None
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
out={}
for name in z.namelist():
 if name.endswith('.xml') or name.endswith('.rels'): E.fromstring(z.read(name))
 if name.startswith('xl/worksheets/'):
  root=E.fromstring(z.read(name)); out[name]=[{'type':c.get('t'),'text':''.join(c.itertext())} for c in root.findall('.//s:c',ns)]
print(json.dumps(out))`,
      ],
      { input: bytes, encoding: 'utf8' },
    ),
  ) as Record<string, { type: string | null; text: string }[]>;
}
describe('real Excel workbook package and accountant boundary', () => {
  it('opens as a valid ZIP/XML workbook with typed numbers and inert untrusted strings', () => {
    const out = inspect(
      xlsx([
        {
          name: 'Achats & TVA',
          rows: [
            ['Pièce', 'Montant'],
            ['=HYPERLINK("evil")', 123.45],
            ['+SUM(A1)', -10],
            ['الحديد', 0],
          ],
        },
      ]),
    );
    const cells = out['xl/worksheets/sheet1.xml']!;
    expect(cells.find((c) => c.text.startsWith('=HYPERLINK'))?.type).toBe('inlineStr');
    expect(cells.find((c) => c.text === '123.45')?.type).toBeNull();
    expect(cells.some((c) => c.text === 'الحديد')).toBe(true);
  });
  it('contains journals, avoirs and VAT summary only, with signed credit notes', () => {
    const bytes = accountantWorkbook(
      [
        {
          journal: 'sales',
          number: 'FA-2026-1',
          date: '2026-11-01',
          party: 'Client',
          htCentimes: 10000,
          vatCentimes: 2000,
          ttcCentimes: 12000,
          vatRateBp: 2000,
        },
        {
          journal: 'sales',
          number: 'AV-2026-1',
          date: '2026-11-02',
          party: 'Client',
          creditNoteOf: 'FA-2026-1',
          htCentimes: -1000,
          vatCentimes: -200,
          ttcCentimes: -1200,
          vatRateBp: 2000,
        },
      ],
      '2026-11-01',
      '2026-11-30',
    );
    const out = inspect(bytes);
    expect(Object.keys(out)).toHaveLength(4);
    const text = JSON.stringify(out);
    expect(text).toContain('FA-2026-1');
    expect(text).toContain('90');
    expect(text).not.toMatch(/treasury|steel|loan|cash|balanceCentimes/);
  });
  it('refuses journals that do not reconcile', () => {
    expect(() =>
      accountantWorkbook(
        [
          {
            journal: 'sales',
            number: 'x',
            date: '2026-11-01',
            party: 'x',
            htCentimes: 100,
            vatCentimes: 20,
            ttcCentimes: 130,
            vatRateBp: 2000,
          },
        ],
        '2026-11-01',
        '2026-11-30',
      ),
    ).toThrow('JOURNAL_DOES_NOT_RECONCILE');
  });
});
