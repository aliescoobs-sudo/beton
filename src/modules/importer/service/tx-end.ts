import type pg from 'pg';

// R14-03: how the one transaction of an import or of a rollback ENDS, told truthfully.
//   - A COMMIT is awaited and its answer checked BEFORE anything is reported as applied.
//   - A COMMIT that the server answered with an error, or that PostgreSQL turned into a ROLLBACK (the command tag says so), is
//     COMMIT_FAILED: the work is not there.
//   - A COMMIT that got no answer (the connection broke) is COMMIT_OUTCOME_UNKNOWN: the work may or may not be there. Nobody is told "done".
//   - A transaction that could not be ended cleanly is never given back to the pool: the connection is destroyed, so no live transaction
//     can leak into later work.
// The errors carry a fixed code and a fixed message; the database's own message (which can quote a row) is never copied into them.

export type ImportTransactionCode = 'COMMIT_FAILED' | 'COMMIT_OUTCOME_UNKNOWN' | 'ROLLBACK_FAILED';

const MESSAGES: Record<ImportTransactionCode, string> = {
  COMMIT_FAILED:
    'The database refused the final commit: nothing was written. Run the dry run again; if it is clean and this repeats, ask for help.',
  COMMIT_OUTCOME_UNKNOWN:
    'The connection was lost during the final commit: it is NOT known whether the file was applied. Do not run it again until you have checked (the import audit row of this file, or the dry run, which says "already imported").',
  ROLLBACK_FAILED:
    'The database could not confirm that the transaction was rolled back; the connection was discarded, so nothing can survive on it. The result of this run is not guaranteed: check before trusting it.',
};

export class ImportTransactionError extends Error {
  readonly code: ImportTransactionCode;
  constructor(code: ImportTransactionCode) {
    super(MESSAGES[code]);
    this.name = 'ImportTransactionError';
    this.code = code;
  }
}

/** True when the server itself answered with an error (it has an SQLSTATE); false for a broken connection or a timeout. */
const serverAnswered = (error: unknown): boolean =>
  typeof (error as { code?: unknown } | null)?.code === 'string' &&
  /^[0-9A-Z]{5}$/.test((error as { code: string }).code);

const destroy = (client: pg.PoolClient): void => {
  try {
    client.release(true); // true: the connection is closed, not returned to the pool
  } catch {
    // already gone
  }
};

/** COMMIT, then release. Throws ImportTransactionError unless the server confirmed the commit. */
export async function commitAndRelease(client: pg.PoolClient): Promise<void> {
  let result: pg.QueryResult | undefined;
  try {
    result = await client.query('COMMIT');
  } catch (error) {
    destroy(client);
    throw new ImportTransactionError(serverAnswered(error) ? 'COMMIT_FAILED' : 'COMMIT_OUTCOME_UNKNOWN');
  }
  // COMMIT of a transaction that was already aborted is answered "ROLLBACK" without an error: the work is not there.
  if (result?.command !== 'COMMIT') {
    destroy(client);
    throw new ImportTransactionError('COMMIT_FAILED');
  }
  client.release();
}

/** ROLLBACK, then release. A rollback that is not confirmed destroys the connection and throws ROLLBACK_FAILED. */
export async function rollbackAndRelease(client: pg.PoolClient): Promise<void> {
  try {
    const result = await client.query('ROLLBACK');
    if (result?.command !== 'ROLLBACK') throw new Error('not confirmed');
  } catch {
    destroy(client);
    throw new ImportTransactionError('ROLLBACK_FAILED');
  }
  client.release();
}

/** The error path: roll back if possible, destroy the connection if not, and never mask the error that is already on its way. */
export async function abandon(client: pg.PoolClient): Promise<void> {
  await rollbackAndRelease(client).catch(() => undefined);
}
