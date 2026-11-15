import { z } from 'zod';
import type { DateFormat } from './sheet';

// A mapping file describes ONE sheet of a workbook: which sheet, what it holds, where its headers are and what each header is called.
// The real headers of the company's files are not known yet, so nothing about them is in the code: the defaults below are only a
// starting point, and a mapping file replaces them without touching the importer (docs/IMPORT-EXCEL.md).

export const MAPPING_KINDS = [
  'concrete_types',
  'components',
  'recipes',
  'clients',
  'suppliers',
  'trucks',
  'pumps',
  'selling_prices',
  'opening_balances',
  'cheques_in_transit',
  'invoice_sequence',
  'doc_counters',
  'account_balances',
  'cheques_issued',
  'open_items',
  'obligations',
  'opening_stock',
] as const;
export type MappingKind = (typeof MAPPING_KINDS)[number];

/**
 * The order a workbook is applied in: later sheets refer to earlier ones (a recipe to its type and components, a price to its type,
 * an opening balance or a cheque to its client). Whatever the order of the sheets in the file, this is the order of the work.
 */
export const APPLY_ORDER: readonly MappingKind[] = [
  'concrete_types',
  'components',
  'recipes',
  'clients',
  'suppliers',
  'trucks',
  'pumps',
  'selling_prices',
  'opening_balances',
  'cheques_in_transit',
  'invoice_sequence',
  'doc_counters',
  'account_balances',
  'cheques_issued',
  'open_items',
  'obligations',
  'opening_stock',
];

const headerNames = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((v) => (typeof v === 'string' ? [v] : v));

export const sheetMappingSchema = z
  .strictObject({
    version: z.literal(1),
    /** The sheet's name as written in the workbook (case and accents ignored); "*" is the one sheet of a CSV or of a single-sheet file. */
    sheet: z.string().min(1).max(100),
    kind: z.enum(MAPPING_KINDS),
    /** 1-based row of the headers; the rows above (a title, a date) are ignored. */
    headerRow: z.number().int().min(1).max(50).default(1),
    /** How a text date is written in this sheet. Declared, never guessed. Excel date cells and ISO dates always work. */
    dateFormat: z.enum(['dmy', 'mdy', 'iso']).default('dmy'),
    /** Field -> the header(s) that mean it in this sheet; replaces the default names of that field. */
    columns: z.record(z.string(), headerNames).default({}),
    /**
     * R14-04: a sheet with formula cells is REFUSED unless this is true. The reader never evaluates a formula; with this flag it takes
     * the value Excel last stored with it (it can be stale or wrong) and the report says how many cells were read that way.
     */
    allowCachedFormulaValues: z.boolean().optional(),
    /** The plant code to use when a row has no plant of its own (prices, recipes, trucks). */
    defaultPlant: z
      .string()
      .regex(/^[A-Za-z]{2,8}$/)
      .optional(),
  })
  .strict();
export type SheetMapping = z.infer<typeof sheetMappingSchema>;

export type MappingResult = { ok: true; value: SheetMapping } | { ok: false; problems: string[] };

/** Reads one mapping file's JSON text. `fields` is the field list of the kind, so a typo in a field name is refused, not ignored. */
export function parseMapping(
  text: string,
  fieldsOf: (kind: MappingKind) => readonly string[],
): MappingResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['not valid JSON'] };
  }
  const parsed = sheetMappingSchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`),
    };
  const fields = fieldsOf(parsed.data.kind);
  const unknown = Object.keys(parsed.data.columns).filter((f) => !fields.includes(f));
  if (unknown.length)
    return {
      ok: false,
      problems: unknown.map((f) => `columns.${f}: not a field of ${parsed.data.kind} (${fields.join(', ')})`),
    };
  return { ok: true, value: parsed.data };
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .trim();

/** The mapping that applies to a sheet name: the exact name first, then "*" when the workbook has only one sheet. */
export function mappingForSheet(
  mappings: readonly SheetMapping[],
  sheetName: string,
  sheetCount: number,
): SheetMapping | undefined {
  return (
    mappings.find((m) => m.sheet !== '*' && norm(m.sheet) === norm(sheetName)) ??
    (sheetCount === 1 ? mappings.find((m) => m.sheet === '*') : undefined)
  );
}

export type { DateFormat };
