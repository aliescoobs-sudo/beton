import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPLY_ORDER, type MappingKind, parseMapping, type SheetMapping } from '../domain/mapping';
import { defaultColumnsOf, fieldsOf, type ImportKind } from './importers';

// Mapping files: one JSON per sheet. Without any, the built-in defaults below apply (French sheet names, the usual headers); the real
// headers of the company's files are not known yet, so the way to adapt is to write mapping files (docs/IMPORT-EXCEL.md).

const MAX_MAPPING_BYTES = 64 * 1024;

export const DEFAULT_SHEET_NAMES: Record<MappingKind, string> = {
  concrete_types: 'Types',
  components: 'Composants',
  recipes: 'Recettes',
  clients: 'Clients',
  suppliers: 'Fournisseurs',
  trucks: 'Camions',
  pumps: 'Pompes',
  selling_prices: 'Prix',
  opening_balances: 'Soldes',
  cheques_in_transit: 'Cheques',
  invoice_sequence: 'Facture',
  doc_counters: 'Compteurs',
  account_balances: 'Comptes',
  cheques_issued: 'ChequesEmis',
};

/** The built-in mapping of a kind: its default sheet name, headers on row 1, dates day first, the usual header names. */
export function defaultMapping(kind: MappingKind): SheetMapping {
  return {
    version: 1,
    sheet: DEFAULT_SHEET_NAMES[kind],
    kind,
    headerRow: 1,
    dateFormat: 'dmy',
    columns: {},
  };
}
export const defaultMappings = (): SheetMapping[] => APPLY_ORDER.map(defaultMapping);

export interface LoadedMappings {
  mappings: SheetMapping[];
  /** One line per problem, naming the mapping file (never a cell). Any problem stops the run. */
  problems: string[];
}

/** Reads one mapping file or every `*.json` file of a folder. */
export function loadMappingFiles(path: string): LoadedMappings {
  const out: LoadedMappings = { mappings: [], problems: [] };
  if (!existsSync(path)) return { mappings: [], problems: [`${path}: not found`] };
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => join(path, f))
    : [path];
  if (files.length === 0) out.problems.push(`${path}: no .json mapping file in this folder`);
  for (const file of files) {
    if (statSync(file).size > MAX_MAPPING_BYTES) {
      out.problems.push(`${file}: too large for a mapping file`);
      continue;
    }
    const parsed = parseMapping(readFileSync(file, 'utf8'), (kind) => fieldsOf(kind as ImportKind));
    if (parsed.ok) out.mappings.push(parsed.value);
    else for (const p of parsed.problems) out.problems.push(`${file}: ${p}`);
  }
  const seen = new Set<string>();
  for (const m of out.mappings) {
    const key = m.sheet.toLowerCase();
    if (seen.has(key)) out.problems.push(`two mapping files name the sheet "${m.sheet}"`);
    seen.add(key);
  }
  return out;
}

/** Writes one editable mapping file per kind into `dir` (default headers spelled out). Never overwrites a file. */
export function writeDefaultMappingFiles(dir: string): { written: string[]; skipped: string[] } {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const skipped: string[] = [];
  for (const kind of APPLY_ORDER) {
    const file = join(dir, `${kind}.json`);
    if (existsSync(file)) {
      skipped.push(file);
      continue;
    }
    const content = { ...defaultMapping(kind), columns: defaultColumnsOf(kind as ImportKind) };
    writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`, { flag: 'wx' });
    written.push(file);
  }
  return { written, skipped };
}
