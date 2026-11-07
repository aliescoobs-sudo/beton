// Public surface of the importer (R9). Other modules import only from here.
export {
  APPLY_ORDER,
  type MappingKind,
  MAPPING_KINDS,
  mappingForSheet,
  parseMapping,
  type SheetMapping,
} from './domain/mapping';
export {
  defaultColumnsOf,
  fieldsOf,
  formatReport,
  IMPORT_KINDS,
  type ImportKind,
  type ImportReport,
  type ImportRow,
  runImport,
} from './service/importers';
export {
  type DateFormat,
  type NamedSheet,
  readCsv,
  readSheet,
  readWorkbook,
  readXlsx,
  readXlsxSheets,
  type Sheet,
  SheetError,
  toIsoDate,
  toRecords,
} from './domain/sheet';
export { type Parsed, parseImportAmount, parseWholeNumber } from './domain/values';
export {
  assertImportEnvironment,
  importWorkbook,
  ImportRefused,
  rollbackImport,
  type RollbackReport,
  type SheetReport,
  type WorkbookOptions,
  type WorkbookReport,
} from './service/workbook-import';
export { ImportTransactionError, type ImportTransactionCode } from './service/tx-end';
export { type ImportEnvironment, importEnvironmentProblem } from './domain/guard';
export { formatRollbackReport, formatWorkbookReport } from './service/report';
export {
  DEFAULT_SHEET_NAMES,
  defaultMapping,
  defaultMappings,
  loadMappingFiles,
  type LoadedMappings,
  writeDefaultMappingFiles,
} from './service/mapping-files';
export {
  EXPECTED_PROBLEMS,
  syntheticProblemWorkbook,
  syntheticValidWorkbook,
  type SyntheticOptions,
} from './fixtures';
export { buildWorkbook } from './domain/xlsx-writer';
