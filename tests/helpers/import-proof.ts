import { createHash } from 'node:crypto';
import {
  importConfirmation,
  importWorkbook as realImport,
  rollbackConfirmation,
  rollbackImport as realRollback,
  type WorkbookOptions,
} from '../../src/modules/importer';

// R14-11: an apply and a rollback need a second-factor proof bound to the operation. The tests of the importer's own behaviour call these
// wrappers, which add the proof that the CLI would have produced after a verified code; the tests of the binding itself call the real
// functions with a wrong or missing proof (tests/import-stepup.int.test.ts).
export const importWorkbook = (o: WorkbookOptions) =>
  realImport({
    ...o,
    stepUp:
      o.stepUp ??
      (o.mode === 'apply'
        ? {
            userId: o.actor.id,
            operation: importConfirmation({
              fileSha256: createHash('sha256').update(o.file).digest('hex'),
              mappings: o.mappings,
              openingDate: o.openingDate ?? null,
            }).operation,
          }
        : undefined),
  });

export const rollbackImport = (o: Parameters<typeof realRollback>[0]) =>
  realRollback({
    ...o,
    stepUp: o.stepUp ?? { userId: o.actor.id, operation: rollbackConfirmation(o.runId).operation },
  });
