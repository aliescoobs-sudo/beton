import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildWorkbook } from '../domain/xlsx-writer';
import { TWIN_EXPENSE_LABELS, TWIN_MARKER_SHEET, TWIN_MARKER_TEXT } from './domain/guard';
import { type HistoryMapping } from './domain/mapping';

// T11: the TWIN. Fictitious workbooks with the structure of the company's monthly files (sheet names, header rows and spellings, column order
// that differs between the two plants, a formatted range of 257 columns, copied template sheets, totals formulas, trailing blanks, an
// autofilter a strict parser rejects) and the known data problems. Nothing here comes from a real file: every name carries FICTIF, the numbers
// come from a seeded generator, and a marker sheet signs each file as synthetic. The guard (domain/guard.ts) lets only these files into the
// training instance and keeps them out of production.

type Cell = string | number | { f: string; v: string | number };
const SYLLABLES = [
  'KA',
  'RI',
  'MO',
  'SA',
  'LI',
  'NA',
  'TO',
  'BE',
  'DA',
  'YU',
  'ZE',
  'FA',
  'HO',
  'MI',
  'RA',
  'SU',
  'LE',
  'VO',
  'NI',
  'TA',
];
const serialOf = (iso: string): number =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TwinFile {
  /** Relative path inside the output folder. */
  path: string;
  buf: Buffer;
}
export interface TwinOptions {
  seed?: number;
  /** Rows per plant over the nine months (defaults 1200 and 800) and distinct client names (160 and 50). */
  belgoRows?: number;
  chaounRows?: number;
  belgoClients?: number;
  chaounClients?: number;
}

const name = (rnd: () => number, parts: number) =>
  Array.from({ length: parts }, () => SYLLABLES[Math.floor(rnd() * SYLLABLES.length)]).join('');

/** n distinct client names, each with the FICTIF marker, plus the near-duplicate spellings an office writes by hand. */
function clientNames(rnd: () => number, n: number): { canonical: string[]; spellings: string[][] } {
  const seen = new Set<string>();
  const canonical: string[] = [];
  while (canonical.length < n) {
    const base = `${name(rnd, 2 + Math.floor(rnd() * 2))} FICTIF`;
    if (!seen.has(base)) {
      seen.add(base);
      canonical.push(base);
    }
  }
  const spellings = canonical.map((c, i) => {
    const v = [c];
    if (i % 4 === 0) v.push(`${c} 1`, `${c} 2`);
    if (i % 7 === 0) v.push(c.replace(' ', '  '), c.toLowerCase());
    if (i % 9 === 0) v.push(c.replace(/^(\w)(\w)/, '$2$1')); // two letters swapped in the first word
    if (i % 11 === 0) v.push(`${c.split(' ')[0]}  FICTIF`);
    return v;
  });
  return { canonical, spellings };
}

const TYPES = ['B25 ', 'B 25', 'B25', 'b25', 'B25HYD', 'BB25', 'B26', 'B27', 'B25', 'B25', 'B 27'];
const PUMPS = ['POMPE', 'P', 'GOULOTTE', 'G', 'P SITRAD', '', 'pompe', ''];
const plate = (n: number, v: number) =>
  v % 3 === 0 ? `FX ${1000 + n}` : v % 3 === 1 ? `fx${1000 + n}` : `FX-${1000 + n}`;

interface PlantSpec {
  title: 'BELGO' | 'CHAOUN';
  headers: string[];
  rowsTotal: number;
  clients: number;
  months: number[]; // 1..9 present
  ordinalOfM3: number;
}

function deliveryRows(
  rnd: () => number,
  spec: PlantSpec,
  month: number,
  count: number,
  bl: { next: number },
  ctx: ReturnType<typeof clientNames>,
): Cell[][] {
  const out: Cell[][] = [];
  const drivers = [
    'SAMIR FICTIF',
    'LAHCEN FICTIF',
    'ZINEB FICTIF',
    'YOUNES FICTIF',
    'NADIA FICTIF',
    'RACHID FICTIF',
  ];
  const days = new Date(Date.UTC(2026, month, 0)).getUTCDate();
  for (let i = 0; i < count; i++) {
    const ci = Math.floor(rnd() * ctx.canonical.length);
    const names = ctx.spellings[ci] as string[];
    const client = names[Math.floor(rnd() * names.length)] as string;
    // a few rows belong to the next month (the file holds the first days of the following month)
    const spill = i >= count - 3 && month < 12;
    const day = spill ? 1 + Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * days);
    const iso = spill ? `2026-${pad(month + 1)}-${pad(day)}` : `2026-${pad(month)}-${pad(day)}`;
    const date: Cell = rnd() < 0.15 ? `${pad(day)}/${pad(spill ? month + 1 : month)}/2026` : serialOf(iso);
    const m3 = Math.round((3 + rnd() * 9) * 2) / 2;
    const truckN = Math.floor(rnd() * 9);
    const truck = rnd() < 0.2 ? String(truckN + 1) : plate(truckN, Math.floor(rnd() * 3));
    // delivery note: a running number with a few duplicates and gaps; the Chefchaouen book of the first two months holds conversion garbage
    let blv: Cell;
    if (spec.title === 'CHAOUN' && month <= 2 && rnd() < 0.2)
      blv = 900000000000 + Math.floor(rnd() * 99999999999);
    else {
      bl.next += rnd() < 0.05 ? 3 : 1;
      blv = rnd() < 0.03 ? bl.next - 1 : bl.next;
    }
    const obs = rnd() < 0.06 ? 'POUR LE COMPTE DE PARTENAIRE FICTIF' : '';
    const tax = rnd() < 0.3 ? (rnd() < 0.5 ? 'HT' : 'TTC') : '';
    const row: Record<string, Cell> = {
      DATE: date,
      CLIENTS: client,
      CHANTIERS: `CHANTIER FICTIF ${1 + Math.floor(rnd() * 40)}`,
      M3: m3,
      TYPE: TYPES[Math.floor(rnd() * TYPES.length)] as string,
      CAMION: truck,
      MATRICULE: truck,
      BL: blv,
      'B,L': blv,
      POMPE: PUMPS[Math.floor(rnd() * PUMPS.length)] as string,
      OBSERVATIONS: obs,
      COMERCIAL: spec.title === 'CHAOUN' ? (drivers[Math.floor(rnd() * drivers.length)] as string) : '',
      'CODE CLIENT': '',
      TRANSPORTEUR: drivers[Math.floor(rnd() * drivers.length)] as string,
      ADJUVANT: spec.title === 'BELGO' ? (rnd() < 0.2 ? (tax === '' ? 'HT' : 'PLASTIFIANT') : '') : '',
      'HT/T': spec.title === 'BELGO' && tax !== '' && rnd() < 0.6 ? tax : '',
      '': spec.title === 'CHAOUN' && month >= 6 && rnd() < 0.3 ? 'SIKA FICTIF' : '',
    };
    if (spec.title === 'CHAOUN' && month >= 6) row['HT/T'] = rnd() < 0.3 ? tax : '';
    // problem rows: no date, empty m3 (a handful)
    if (i === 5) row.DATE = '';
    if (i === 9) row.M3 = '';
    out.push(
      spec.headers.map((h, k) =>
        spec.title === 'CHAOUN' && h === '' ? (row[''] as Cell) : (row[h] ?? ''),
      ) as Cell[],
    );
  }
  return out;
}

function plantWorkbook(spec: PlantSpec, month: number, rows: Cell[][]): Buffer {
  const first = 3;
  const last = first + rows.length - 1;
  const m3Col = spec.headers.indexOf('M3');
  const letter = String.fromCharCode(65 + m3Col);
  const total = rows.reduce((s, r) => s + (typeof r[m3Col] === 'number' ? (r[m3Col] as number) : 0), 0);
  const totals: Cell[] = spec.headers.map((_, k) =>
    k === m3Col ? { f: `SUM(${letter}${first}:${letter}${last})`, v: total } : '',
  );
  const footer: Cell[] = spec.headers.map((_, k) =>
    k === m3Col ? { f: `SUM(${letter}${first}:${letter}${last})`, v: total } : '',
  );
  const stale = (n: string): { name: string; rows: Cell[][] } => ({
    name: n,
    rows: [
      [`ANCIEN ${n} FICTIF`, 2024, 12],
      ['NOTE MANUELLE FICTIVE', 'a recopier'],
    ],
  });
  return buildWorkbook(
    [
      {
        name: 'LIVRAISON 1',
        rows: [totals, spec.headers, ...rows, footer, [], []],
        formattedColumns: 257,
        autoFilterRef: month % 4 === 0 ? 'A2:IV' : undefined, // the quirk: a reference a strict parser rejects
      },
      stale('PATR HT'),
      stale('PATR TTC'),
      stale('RECAP'),
      stale('00'),
      stale('Feuil1'),
      stale('Feuil2'),
      stale('Feuil3'),
      { name: TWIN_MARKER_SHEET, rows: [[TWIN_MARKER_TEXT]] },
    ],
    true,
  );
}

const BELGO: PlantSpec = {
  title: 'BELGO',
  headers: [
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
  ],
  rowsTotal: 1200,
  clients: 160,
  months: [1, 3, 4, 5, 6, 7, 8, 9], // no February file
  ordinalOfM3: 3,
};
const CHAOUN: PlantSpec = {
  title: 'CHAOUN',
  headers: [
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
  ],
  rowsTotal: 800,
  clients: 50,
  months: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  ordinalOfM3: 3,
};

function expenseWorkbook(month: number, rnd: () => number): Buffer {
  const labels = [
    'GASOIL',
    'GASOIL',
    'GASOIL',
    'PNEU',
    'FILTRE',
    'AVANCE',
    'BUREAU',
    ...TWIN_EXPENSE_LABELS.slice(-3),
  ];
  const rows: Cell[][] = [];
  const hasDate = month > 1; // January has no DATE column
  const n = 28 + Math.floor(rnd() * 10);
  for (let i = 0; i < n; i++) {
    const label = labels[Math.floor(rnd() * labels.length)] as string;
    const litres =
      label === 'GASOIL' ? ` ${(40 + Math.floor(rnd() * 8000) / 100).toFixed(2).replace('.', ',')} L` : '';
    const day = 1 + Math.floor(rnd() * 27);
    const amount: Cell =
      rnd() < 0.2
        ? `${1 + Math.floor(rnd() * 9)} ${String(Math.floor(rnd() * 999)).padStart(3, '0')},50`
        : Number((10 + Math.floor(rnd() * 9000) + Math.floor(rnd() * 100) / 100).toFixed(2));
    const mat =
      rnd() < 0.6 ? plate(Math.floor(rnd() * 9), Math.floor(rnd() * 3)) : String(Math.floor(rnd() * 90000));
    rows.push(
      hasDate
        ? [serialOf(`2026-${pad(month)}-${pad(day)}`), label + litres, amount, mat]
        : [label + litres, amount, mat],
    );
  }
  rows.push(
    hasDate
      ? ['', '', { f: `SUM(C2:C${rows.length + 1})`, v: 0 }, '']
      : ['', { f: `SUM(B2:B${rows.length + 1})`, v: 0 }, ''],
  );
  const journal = [
    hasDate ? ['DATE', 'IMUTATION', 'MONTANT', 'MATRICULE'] : ['IMUTATION', 'MONTANT', 'MATRICULE'],
    ...rows,
  ];
  const copied = (n: string): { name: string; rows: Cell[][] } => ({
    name: n,
    rows: [
      ['ANCIEN FICTIF', 'REPORT'],
      ['COPIE', 'FICTIVE', 100],
    ],
  });
  const norsecam: Cell[][] = [['DATE', 'IMUTATION', 'MONTANT']];
  if (month === 5 || month === 6)
    for (let i = 0; i < 85; i++)
      norsecam.push([serialOf(`2026-${pad(month)}-${pad(1 + (i % 27))}`), 'DIVERS FICTIF', 50 + i]);
  else if (month >= 7) for (let i = 0; i < 6; i++) norsecam.push(['', 'DIVERS FICTIF', 20 + i]);
  return buildWorkbook(
    [
      { name: 'Feuil1', rows: journal, formattedColumns: 12 },
      { name: 'NORSECAM', rows: norsecam },
      copied('Feuil2'),
      copied('Feuil3'),
      copied('Feuil4'),
      copied('zamzam'),
      { name: TWIN_MARKER_SHEET, rows: [[TWIN_MARKER_TEXT]] },
    ],
    true,
  );
}

/** The mapping files that go with the twin (structure only), keyed by file name. */
export function twinMappings(): Record<string, HistoryMapping> {
  const base = {
    version: 1 as const,
    dateFormat: 'dmy' as const,
    includeSheets: [] as string[],
    legacyColumns: [] as string[],
    blankHeaderField: null as string | null,
  };
  return {
    'deliveries-tetouan.json': {
      ...base,
      kind: 'deliveries',
      plant: 'BELGO',
      plantCode: 'TETOUAN',
      sheet: 'LIVRAISON 1',
      headerRow: 2,
      columns: { driver: ['TRANSPORTEUR'], truck: ['CAMION'], bl: ['B,L'] },
      legacyColumns: ['COMERCIAL', 'CODE CLIENT'],
      fileMonths: {},
    },
    'deliveries-chaoun.json': {
      ...base,
      kind: 'deliveries',
      plant: 'CHAOUN',
      plantCode: 'CHEFCHN',
      sheet: 'LIVRAISON 1',
      headerRow: 2,
      columns: { driver: ['COMERCIAL'], truck: ['MATRICULE'] },
      blankHeaderField: 'adjuvant',
      fileMonths: {},
    },
    'expenses.json': {
      ...base,
      kind: 'expenses',
      plant: 'BELGO',
      plantCode: null,
      sheet: 'Feuil1',
      headerRow: 1,
      columns: {},
      fileMonths: { '1': '2026-01' },
    },
  };
}

/** Writes nothing: returns the workbooks. */
export function buildTwin(opts: TwinOptions = {}): TwinFile[] {
  const files: TwinFile[] = [];
  for (const spec of [BELGO, CHAOUN]) {
    const rnd = prng((opts.seed ?? 1) + (spec.title === 'BELGO' ? 0 : 1000));
    const total =
      spec.title === 'BELGO' ? (opts.belgoRows ?? spec.rowsTotal) : (opts.chaounRows ?? spec.rowsTotal);
    const clients = clientNames(
      rnd,
      spec.title === 'BELGO' ? (opts.belgoClients ?? spec.clients) : (opts.chaounClients ?? spec.clients),
    );
    const perMonth = Math.max(12, Math.round(total / spec.months.length));
    const bl = { next: 1000 };
    for (const month of spec.months) {
      const rows = deliveryRows(rnd, spec, month, perMonth, bl, clients);
      const file = `${spec.title === 'BELGO' ? 'tetouan' : 'chaoun'}/BETON ${spec.title} ${pad(month)}.2026${spec.title === 'CHAOUN' && month === 4 ? ' -' : ''}.xlsx`;
      files.push({ path: file, buf: plantWorkbook(spec, month, rows) });
    }
  }
  const rnd = prng((opts.seed ?? 1) + 5000);
  for (let month = 1; month <= 9; month++)
    files.push({ path: `charges/CHARGES ${pad(month)}.2026.xlsx`, buf: expenseWorkbook(month, rnd) });
  return files;
}

/** Writes the twin into a folder (it must be new or empty of twin files) with its mapping files; returns the paths. */
export function writeTwin(folder: string, opts: TwinOptions = {}): string[] {
  const written: string[] = [];
  for (const f of buildTwin(opts)) {
    const target = path.join(folder, f.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, f.buf, { flag: 'wx' });
    written.push(target);
  }
  mkdirSync(path.join(folder, 'mapping'), { recursive: true });
  for (const [file, m] of Object.entries(twinMappings())) {
    const target = path.join(folder, 'mapping', file);
    writeFileSync(target, `${JSON.stringify(m, null, 2)}\n`, { flag: 'wx' });
    written.push(target);
  }
  return written;
}
