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
  IMPORT_KINDS,
  type ImportKind,
  type ImportReport,
  type ImportRow,
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
export { importConfirmation, rollbackConfirmation, type StepUpProof } from './domain/confirmation';
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
// T11: the history importer (deliveries and expenses as a separate flagged layer), its fictitious twin and its guard.
export {
  historyEnvironmentProblem,
  TWIN_MARKER_SHEET,
  TWIN_MARKER_TEXT,
  type HistoryEnvironment,
} from './history/domain/guard';
export {
  exampleMappings,
  parseHistoryMapping,
  type HistoryKind,
  type HistoryMapping,
} from './history/domain/mapping';
export {
  assertHistoryEnvironment,
  historyConfirmation,
  historyPurgeConfirmation,
  purgeStaging,
  historyRollbackConfirmation,
  type HistoryOptions,
  type HistoryReport,
  type HistoryRollbackReport,
  rollbackHistory,
  runHistory,
} from './history/service/history-import';
export { formatHistoryReport, formatHistoryRollback } from './history/service/report';
export { type InputFile, readSet } from './history/service/read-set';
export { buildTwin, twinMappings, writeTwin, type TwinOptions } from './history/twin';
export {
  decideLabel,
  decideQuarantine,
  type ExpenseHistoryRow,
  historyClientVolume,
  historyExpenses,
  historyVolume,
  type HistoryError,
  type LabelKind,
  type LabelRow,
  listLabels,
  listQuarantine,
  listStagedSets,
  type StagedSet,
  mappingTargets,
  type QuarantineRow,
  reconciliation,
  type ReconRow,
  type VolumeRow,
} from './history/service/staging';
