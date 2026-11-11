import { z } from 'zod';
import type { DateFormat } from '../../domain/sheet';

// T11: one mapping file per plant per kind (deliveries, expenses). The headers are CONFIGURATION: the two plants write their columns in a
// different order and with different names, so a column is found by its header name, never by its position.

export const HISTORY_KINDS = ['deliveries', 'expenses'] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export const DELIVERY_FIELDS = [
  'date',
  'client',
  'site',
  'm3',
  'type',
  'truck',
  'driver',
  'bl',
  'pump',
  'observations',
  'taxbasis',
  'adjuvant',
] as const;
export const EXPENSE_FIELDS = ['date', 'label', 'amount', 'truck'] as const;
export const REQUIRED_FIELDS: Record<HistoryKind, readonly string[]> = {
  deliveries: ['date', 'client', 'm3'],
  expenses: ['label', 'amount'],
};

/** The headers accepted by default, folded on comparison (case, accents and punctuation ignored). A mapping file replaces them per field. */
export const DEFAULT_HEADERS: Record<HistoryKind, Record<string, string[]>> = {
  deliveries: {
    date: ['DATE'],
    client: ['CLIENTS', 'CLIENT'],
    site: ['CHANTIERS', 'CHANTIER'],
    m3: ['M3', 'M 3'],
    type: ['TYPE'],
    truck: ['CAMION', 'MATRICULE'],
    driver: ['TRANSPORTEUR'],
    bl: ['BL', 'B L'],
    pump: ['POMPE'],
    observations: ['OBSERVATIONS', 'OBSERVATION'],
    taxbasis: ['HT/T', 'HT T'],
    adjuvant: ['ADJUVANT'],
  },
  expenses: { date: ['DATE'], label: ['IMUTATION', 'IMPUTATION'], amount: ['MONTANT'], truck: ['MATRICULE'] },
};

const headerNames = z.union([z.string().min(1).max(80), z.array(z.string().min(1).max(80)).min(1).max(10)]);

const schema = z
  .object({
    version: z.literal(1),
    kind: z.enum(HISTORY_KINDS),
    /** The plant as the FILES call it (BELGO, CHAOUN): free configuration, never read from a file name. */
    plant: z.string().regex(/^[A-Z0-9]{2,12}$/),
    /** The plant's code in the application (decision 211: configuration, e.g. BELGO is the Tétouan plant). Null: the rows have no plant. */
    plantCode: z
      .string()
      .regex(/^[A-Z]{2,8}$/)
      .nullable(),
    sheet: z.string().min(1).max(80),
    headerRow: z.number().int().min(1).max(50).default(1),
    dateFormat: z.enum(['dmy', 'mdy', 'iso']).default('dmy'),
    columns: z.record(z.string(), headerNames).default({}),
    /** Headers kept as they are in the row's `legacy` JSON (a commercial tag, a legacy payment flag, "CODE CLIENT"): stored, never interpreted. */
    legacyColumns: z.array(z.string().min(1).max(80)).max(30).default([]),
    /** The field a header-less column takes, when exactly one header-less column holds data (CHAOUN's ADJUVANT from June). */
    blankHeaderField: z.string().max(30).nullable().default(null),
    /** Expenses: other sheets read like the journal, each only when it has a DATE column (explicit, per sheet; everything else is ignored). */
    includeSheets: z.array(z.string().min(1).max(80)).max(10).default([]),
    /** Expenses: the month ("2026-01") of a file by its position in the folder (1-based), for a journal with no DATE column. */
    fileMonths: z
      .record(z.string().regex(/^[0-9]{1,3}$/), z.string().regex(/^20[0-9]{2}-(0[1-9]|1[0-2])$/))
      .default({}),
  })
  .strict();

export interface HistoryMapping {
  version: 1;
  kind: HistoryKind;
  plant: string;
  plantCode: string | null;
  sheet: string;
  headerRow: number;
  dateFormat: DateFormat;
  columns: Record<string, string[]>;
  legacyColumns: string[];
  blankHeaderField: string | null;
  includeSheets: string[];
  fileMonths: Record<string, string>;
}

export function parseHistoryMapping(
  input: unknown,
): { ok: true; value: HistoryMapping } | { ok: false; problem: string } {
  const r = schema.safeParse(input);
  if (!r.success)
    return {
      ok: false,
      problem: `mapping refused: ${r.error.issues.map((i) => i.path.join('.') || 'file').join(', ')}`,
    };
  const v = r.data;
  const allowed: readonly string[] = v.kind === 'deliveries' ? DELIVERY_FIELDS : EXPENSE_FIELDS;
  const unknown = Object.keys(v.columns).filter((f) => !allowed.includes(f));
  if (unknown.length)
    return { ok: false, problem: `mapping refused: unknown field(s) ${unknown.join(', ')}` };
  if (v.blankHeaderField && !allowed.includes(v.blankHeaderField))
    return { ok: false, problem: 'mapping refused: blankHeaderField' };
  const columns: Record<string, string[]> = {};
  for (const [f, names] of Object.entries(v.columns)) columns[f] = Array.isArray(names) ? names : [names];
  return { ok: true, value: { ...v, columns } };
}

/** The columns of a mapping: the defaults, replaced field by field by the file's own. */
export const columnsOf = (m: HistoryMapping): Record<string, string[]> => ({
  ...DEFAULT_HEADERS[m.kind],
  ...m.columns,
});

/** The editable starting point written by --init-mapping: what the two plants' sheets are known to look like (structure only). */
export function exampleMappings(): HistoryMapping[] {
  const base = {
    version: 1 as const,
    headerRow: 2,
    dateFormat: 'dmy' as const,
    includeSheets: [],
    fileMonths: {},
  };
  return [
    {
      ...base,
      kind: 'deliveries',
      plant: 'BELGO',
      plantCode: 'TETOUAN',
      sheet: 'LIVRAISON 1',
      columns: { driver: ['TRANSPORTEUR'], truck: ['CAMION'], bl: ['B,L'] },
      legacyColumns: ['COMERCIAL', 'CODE CLIENT'],
      blankHeaderField: null,
    },
    {
      ...base,
      kind: 'deliveries',
      plant: 'CHAOUN',
      plantCode: 'CHEFCHN',
      sheet: 'LIVRAISON 1',
      columns: { driver: ['COMERCIAL'], truck: ['MATRICULE'] },
      legacyColumns: [],
      blankHeaderField: 'adjuvant',
    },
    {
      ...base,
      kind: 'expenses',
      plant: 'BELGO',
      plantCode: null,
      sheet: 'Feuil1',
      headerRow: 1,
      columns: {},
      legacyColumns: [],
      blankHeaderField: null,
    },
  ];
}
