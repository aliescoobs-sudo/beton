import type pg from 'pg';
import type { Keyring } from '@/lib/crypto/keyring';
import type { EncryptedColumn } from '../domain/encrypted-columns';

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface RotationResult {
  table: string;
  column: string;
  rotated: number;
  remaining: number;
}

/** Rows of `spec` still sealed with a key other than the keyring's current one. */
export async function countOnOldKeys(
  pool: pg.Pool,
  spec: EncryptedColumn,
  keyring: Keyring,
): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from ${ident(spec.table)} where ${ident(spec.column)} is not null and ${ident(spec.column)} not like $1`,
    [`f1.${keyring.currentId}.%`],
  );
  return rows[0]!.n;
}

/**
 * Re-encrypts every value of `spec` that is not on the current key. Each update only applies if the value has not
 * changed meanwhile (compare-and-set), so it is safe to run while the app is up, and safe to run again.
 */
export async function rotateColumn(
  pool: pg.Pool,
  spec: EncryptedColumn,
  keyring: Keyring,
  batchSize = 500,
): Promise<RotationResult> {
  let rotated = 0;
  for (;;) {
    const { rows } = await pool.query<{ id: string; value: string }>(
      `select ${ident(spec.idColumn)}::text as id, ${ident(spec.column)} as value from ${ident(spec.table)}
        where ${ident(spec.column)} is not null and ${ident(spec.column)} not like $1 limit $2`,
      [`f1.${keyring.currentId}.%`, batchSize],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const resealed = keyring.encrypt(keyring.decrypt(row.value));
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
    remaining: await countOnOldKeys(pool, spec, keyring),
  };
}
