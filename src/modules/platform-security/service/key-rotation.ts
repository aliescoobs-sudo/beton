import type pg from 'pg';
import type { Keyring } from '@/lib/crypto/keyring';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import { SYSTEM_ACTOR_ID } from '../auth/actors';
import type { EncryptedColumn } from '../domain/encrypted-columns';

/** What rotation needs from a connection: plain queries, possibly each wrapped in a request context. */
export type Queryable = Pick<pg.Pool, 'query'>;

/**
 * Row-level-security tables answer nothing without a request context: run each query as the system actor, whose
 * writes are audited like any other (the system role may update only the sealed columns).
 */
export function asSystemActor(pool: pg.Pool): Queryable {
  const run = (text: string, values?: unknown[]) =>
    withRlsContext(
      pool,
      { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: uuidv7(realClock.now()) },
      (tx) => tx.query(text, values),
    );
  return { query: run } as unknown as Queryable;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** How a column's values are sealed and which of them are already on the current key. */
export interface ColumnCipher {
  currentId: string;
  /** SQL LIKE pattern matching values sealed with the current key. */
  currentPattern: string;
  encrypt(plaintext: string): string | Promise<string>;
  decrypt(sealed: string): string | Promise<string>;
}

export function keyringCipher(keyring: Keyring): ColumnCipher {
  return {
    currentId: keyring.currentId,
    currentPattern: `f1.${keyring.currentId}.%`,
    encrypt: keyring.encrypt,
    decrypt: keyring.decrypt,
  };
}

const asCipher = (sealer: Keyring | ColumnCipher): ColumnCipher =>
  'currentPattern' in sealer ? sealer : keyringCipher(sealer);

export interface RotationResult {
  table: string;
  column: string;
  rotated: number;
  remaining: number;
}

/** Rows of `spec` still sealed with a key other than the keyring's current one. */
export async function countOnOldKeys(
  pool: Queryable,
  spec: EncryptedColumn,
  sealer: Keyring | ColumnCipher,
): Promise<number> {
  const cipher = asCipher(sealer);
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from ${ident(spec.table)} where ${ident(spec.column)} is not null and ${ident(spec.column)} not like $1`,
    [cipher.currentPattern],
  );
  return rows[0]!.n;
}

/**
 * Re-encrypts every value of `spec` that is not on the current key. Each update only applies if the value has not
 * changed meanwhile (compare-and-set), so it is safe to run while the app is up, and safe to run again.
 */
export async function rotateColumn(
  pool: Queryable,
  spec: EncryptedColumn,
  sealer: Keyring | ColumnCipher,
  batchSize = 500,
): Promise<RotationResult> {
  const cipher = asCipher(sealer);
  let rotated = 0;
  for (;;) {
    const { rows } = await pool.query<{ id: string; value: string }>(
      `select ${ident(spec.idColumn)}::text as id, ${ident(spec.column)} as value from ${ident(spec.table)}
        where ${ident(spec.column)} is not null and ${ident(spec.column)} not like $1 limit $2`,
      [cipher.currentPattern, batchSize],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const resealed = await cipher.encrypt(await cipher.decrypt(row.value));
      const { rowCount } = await pool.query(
        `update ${ident(spec.table)} set ${ident(spec.column)} = $1 where ${ident(spec.idColumn)}::text = $2 and ${ident(spec.column)} = $3`,
        [resealed, row.id, row.value],
      );
      rotated += rowCount ?? 0;
    }
  }
  return {
    table: spec.table,
    column: spec.column,
    rotated,
    remaining: await countOnOldKeys(pool, spec, cipher),
  };
}
