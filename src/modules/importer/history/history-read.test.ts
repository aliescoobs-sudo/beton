import { describe, expect, it } from 'vitest';
import { buildWorkbook } from '../domain/xlsx-writer';
import { historyEnvironmentProblem } from './domain/guard';
import { type HistoryMapping } from './domain/mapping';
import { clientKey } from './domain/normalise';
import { labelUsage, readSet } from './service/read-set';
import { buildTwin, twinMappings } from './twin';

const mappings = twinMappings();
const belgo = mappings['deliveries-belgo.json'] as HistoryMapping;
const chaoun = mappings['deliveries-chaoun.json'] as HistoryMapping;
const expenses = mappings['expenses.json'] as HistoryMapping;
const BELGO_HEAD = [
  'DATE',
  'CLIENTS',
  'CHANTIERS',
  'M3',
  'TYPE',
  'CAMION',
  'B,L',
  'POMPE',
  'OBSERVATIONS',
  'COMERCIAL',
  'CODE CLIENT',
  'TRANSPORTEUR',
  'ADJUVANT',
  'HT/T',
];
const CHAOUN_HEAD = [
  'DATE',
  'CLIENTS',
  'CHANTIERS',
  'M3',
  'TYPE',
  'BL',
  'POMPE',
  'MATRICULE',
  'COMERCIAL',
  '',
  'HT/T',
];
// 2026-03-02 as an Excel serial
const D = 46083;
const file = (
  rows: (string | number | { f: string; v: number })[][],
  head: string[],
  extra: Record<string, unknown> = {},
) =>
  buildWorkbook([
    { name: 'LIVRAISON 1', rows: [head.map(() => ''), head, ...rows], ...extra },
    { name: 'RECAP', rows: [['ANCIEN FICTIF']] },
  ]);

describe('the history reader works by header NAME, not by position', () => {
  it('reads the two plants, whose columns are in a different order, into the same fields', () => {
    const b = readSet(
      [
        {
          ord: 1,
          buf: file(
            [
              [
                D,
                'KARI FICTIF',
                'CHANTIER FICTIF 1',
                7.5,
                'B25',
                'FX 1001',
                4001,
                'POMPE',
                'POUR PARTENAIRE FICTIF',
                'X',
                '',
                'SAMIR FICTIF',
                'HT',
                '',
              ],
            ],
            BELGO_HEAD,
          ),
        },
      ],
      belgo,
    );
    const c = readSet(
      [
        {
          ord: 1,
          buf: file(
            [
              [
                D,
                'KARI FICTIF',
                'CHANTIER FICTIF 1',
                7.5,
                'B25',
                4001,
                'POMPE',
                'FX 1001',
                'SAMIR FICTIF',
                '',
                'TTC',
              ],
            ],
            CHAOUN_HEAD,
          ),
        },
      ],
      chaoun,
    );
    for (const r of [b.deliveries[0], c.deliveries[0]]) {
      expect(r).toMatchObject({
        date: '2026-03-02',
        volumeL: 7500,
        client: 'KARI FICTIF',
        typeRaw: 'B25',
        truck: 'FX 1001',
        driver: 'SAMIR FICTIF',
        bl: '4001',
        pumpRaw: 'POMPE',
      });
    }
    expect(b.deliveries[0]?.note).toBe('POUR PARTENAIRE FICTIF');
    expect(b.deliveries[0]?.legacy).toEqual({ comercial: 'X', adjuvant: 'HT' });
    expect(b.deliveries[0]?.taxBasis).toBe('HT'); // taken from ADJUVANT: the HT/T cell is empty
    expect(c.deliveries[0]?.taxBasis).toBe('TTC');
  });

  it('skips the totals rows (formulas), blank rows and trailing formatted blanks; ignores the template sheets', () => {
    const buf = file(
      [
        [D, 'KARI FICTIF', 'C', 8, 'B25', 'FX 1001', 1, 'P', '', '', '', 'S FICTIF', '', ''],
        [],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', { f: 'SUM(D3:D3)', v: 8 }, '', '', '', '', '', '', '', '', '', ''],
      ],
      BELGO_HEAD,
      { formattedColumns: 257, autoFilterRef: 'A2:IV' },
    );
    const r = readSet([{ ord: 1, buf }], belgo);
    expect(r.problems).toEqual([]);
    expect(r.deliveries).toHaveLength(1);
    const stats = r.files[0]?.read[0]?.stats;
    expect(stats).toMatchObject({ rowsRead: 1, formulaRowsSkipped: 1 });
    expect(stats?.blankSkipped).toBeGreaterThanOrEqual(1);
    expect(r.files[0]?.ignored).toEqual([2]); // RECAP, by position
  });

  it('quarantines a row with no date or an empty m3 with a fixed reason, never imports it silently', () => {
    const r = readSet(
      [
        {
          ord: 1,
          buf: file(
            [
              ['', 'KARI FICTIF', 'C', 8, 'B25'],
              [D, 'KARI FICTIF', 'C', '', 'B25'],
              [D, 'KARI FICTIF', 'C', 'huit', 'B25'],
            ],
            BELGO_HEAD,
          ),
        },
      ],
      belgo,
    );
    expect(r.deliveries).toHaveLength(0);
    expect(r.quarantine.map((q) => q.reason)).toEqual(['NO_DATE', 'NO_VOLUME', 'BAD_VOLUME']);
    expect(r.quarantine.map((q) => q.src.row)).toEqual([3, 4, 5]);
  });

  it('reports delivery note duplicates, gaps and suspect values by row number, and keeps the raw value', () => {
    const rows = [1000, 1001, 1001, 1004, 922337203685].map((bl) => [
      D,
      'KARI FICTIF',
      'C',
      8,
      'B25',
      'FX 1001',
      bl,
      'P',
    ]);
    const r = readSet([{ ord: 1, buf: file(rows, BELGO_HEAD) }], belgo);
    const s = r.files[0]?.read[0]?.stats;
    expect(s?.blDuplicateRows).toEqual([4, 5]);
    expect(s?.blGaps).toBe(2);
    expect(s?.blSuspectRows).toEqual([7]);
    expect(r.deliveries.map((d) => d.bl)).toContain('922337203685');
    expect(r.deliveries.at(-1)?.blSuspect).toBe(true);
  });

  it('a blank-header column takes the configured field when exactly one such column holds data', () => {
    const r = readSet(
      [
        {
          ord: 1,
          buf: file(
            [[D, 'KARI FICTIF', 'C', 8, 'B25', 1, 'P', 'FX 1', 'S FICTIF', 'SIKA FICTIF', '']],
            CHAOUN_HEAD,
          ),
        },
      ],
      chaoun,
    );
    expect(r.deliveries[0]?.legacy).toEqual({ adjuvant: 'SIKA FICTIF' });
  });

  it('refuses the 1904 date system and reads a file with an autofilter a strict parser rejects', () => {
    const base = [{ name: 'LIVRAISON 1', rows: [[''], BELGO_HEAD, [D, 'KARI FICTIF', 'C', 8]] }];
    const refused = readSet([{ ord: 1, buf: buildWorkbook(base, false, { date1904: true }) }], belgo);
    expect(refused.files[0]?.problems.join(' ')).toMatch(/1904/);
    expect(refused.deliveries).toHaveLength(0);
    const ok = readSet(
      [{ ord: 1, buf: buildWorkbook([{ ...base[0]!, autoFilterRef: 'A2:' }], false) }],
      belgo,
    );
    expect(ok.deliveries).toHaveLength(1);
  });

  it('a missing required header makes the sheet unreadable (a fixed phrase), not an empty import', () => {
    const r = readSet([{ ord: 1, buf: file([[D, 'KARI FICTIF']], ['DATE', 'CLIENTS']) }], belgo);
    expect(r.files[0]?.problems).toContain('HEADER_MISSING: m3');
  });
});

describe('expenses: Feuil1 only; others behind a flag and a DATE column', () => {
  const journal = (head: string[], rows: (string | number)[][]) =>
    buildWorkbook([
      { name: 'Feuil1', rows: [head, ...rows] },
      {
        name: 'NORSECAM',
        rows: [
          ['DATE', 'IMUTATION', 'MONTANT'],
          [D, 'DIVERS FICTIF', 10],
        ],
      },
      { name: 'zamzam', rows: [['ANCIEN']] },
    ]);
  it('reads litres from the text, the amount in centimes, and a month for a file with no DATE column', () => {
    const r = readSet(
      [
        {
          ord: 1,
          buf: journal(
            ['IMUTATION', 'MONTANT', 'MATRICULE'],
            [
              ['GASOIL 84,22 L', '1 250,50', 'FX 1001'],
              ['PNEU', 99, '12345'],
            ],
          ),
        },
      ],
      expenses,
    );
    expect(r.expenses.map((e) => [e.month, e.date, e.quantityMl, e.amountCentimes])).toEqual([
      ['2026-01', null, 84_220, 125_050],
      ['2026-01', null, null, 9_900],
    ]);
    expect(r.files[0]?.ignored).toEqual([2, 3]); // NORSECAM is not included, zamzam never
  });
  it('a file with no DATE column and no month in the mapping is quarantined, not dated by guess', () => {
    const r = readSet([{ ord: 2, buf: journal(['IMUTATION', 'MONTANT'], [['GASOIL', 5]]) }], expenses);
    expect(r.quarantine.map((q) => q.reason)).toEqual(['NO_DATE']);
  });
  it('an included extra sheet is read only when it has a DATE column', () => {
    const m = { ...expenses, includeSheets: ['NORSECAM', 'zamzam'] };
    const r = readSet([{ ord: 1, buf: journal(['DATE', 'IMUTATION', 'MONTANT'], [[D, 'GASOIL', 5]]) }], m);
    expect(r.expenses).toHaveLength(2);
    expect(r.files[0]?.problems.some((p) => p.startsWith('SHEET_NO_DATE_COLUMN'))).toBe(true);
  });
});

describe('the twin', () => {
  const twin = buildTwin();
  const group = (dir: string) =>
    twin.filter((f) => f.path.startsWith(`${dir}/`)).map((f, i) => ({ ord: i + 1, buf: f.buf }));
  const tet = readSet(group('belgo'), belgo);
  const che = readSet(group('chaoun'), chaoun);

  it('has no February file for the Tétouan plant and nine for Chefchaouen; the three mapping files go with it', () => {
    expect(group('belgo')).toHaveLength(8);
    expect(group('chaoun')).toHaveLength(9);
    expect(group('charges')).toHaveLength(9);
    expect(Object.keys(twinMappings())).toHaveLength(3);
  });
  it('holds about 1200 and 800 delivery rows with the planted problems, all readable by header name', () => {
    expect(tet.problems).toEqual([]);
    expect(tet.files.flatMap((f) => f.problems)).toEqual([]);
    expect(che.files.flatMap((f) => f.problems)).toEqual([]);
    expect(tet.deliveries.length + tet.quarantine.length).toBeGreaterThanOrEqual(1150);
    expect(che.deliveries.length + che.quarantine.length).toBeGreaterThanOrEqual(780);
    expect(tet.quarantine.length).toBeGreaterThan(0);
    expect(new Set(tet.quarantine.map((q) => q.reason))).toEqual(new Set(['NO_DATE', 'NO_VOLUME']));
    // rows of the following month are in the files: the date of the row is the truth
    const months = new Set(tet.deliveries.map((d) => d.date.slice(0, 7)));
    expect(months.has('2026-02')).toBe(true);
    // the book of Chefchaouen's first months carries garbage
    expect(che.files.some((f) => f.read.some((s) => s.stats.blSuspectRows.length > 0))).toBe(true);
    expect(tet.files.some((f) => f.read.some((s) => s.stats.blDuplicateRows.length > 0))).toBe(true);
  });
  it('has ~160 and ~50 client names with near-duplicates, every name marked FICTIF', () => {
    const keys = (r: typeof tet) => new Set(r.deliveries.map((d) => clientKey(d.client)));
    expect(keys(tet).size).toBeGreaterThanOrEqual(140);
    expect(keys(che).size).toBeGreaterThanOrEqual(45);
    for (const r of [tet, che])
      for (const f of r.facts) for (const n of f.names) expect(n.toUpperCase()).toContain('FICTIF');
    expect(labelUsage(tet).size).toBeGreaterThan(150);
  });
  it('every file is signed synthetic; the guard lets the twin into training and keeps it out of production', () => {
    const all = [...tet.facts, ...che.facts, ...readSet(group('charges'), expenses).facts];
    expect(all.every((f) => f.marked)).toBe(true);
    expect(
      historyEnvironmentProblem({ trainingMode: true, realData: false, simulationEnabled: false }, true, all),
    ).toBeNull();
    expect(
      historyEnvironmentProblem(
        { trainingMode: false, realData: true, simulationEnabled: false },
        false,
        all,
      ),
    ).toMatch(/synthetic/);
  });
  it('the expenses carry litres in the text and the journal of January has no date column', () => {
    const ex = readSet(group('charges'), expenses);
    expect(ex.files.flatMap((f) => f.problems.filter((p) => !p.startsWith('SHEET_NO_DATE')))).toEqual([]);
    expect(ex.expenses.some((e) => e.quantityMl !== null)).toBe(true);
    expect(ex.expenses.filter((e) => e.date === null).every((e) => e.month === '2026-01')).toBe(true);
  });
  it('is deterministic: the same seed gives the same bytes', () => {
    expect(buildTwin({ seed: 1 })[0]?.buf.equals(twin[0]!.buf)).toBe(true);
    expect(buildTwin({ seed: 2 })[0]?.buf.equals(twin[0]!.buf)).toBe(false);
  });
});
