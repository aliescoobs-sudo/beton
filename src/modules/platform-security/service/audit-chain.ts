import type pg from 'pg';
// Explicit .ts extension: this file is also loaded by scripts/audit-verify.ts under plain Node.
import { type AuditChainRow, chainHash } from '../domain/audit-canonical.ts';

export interface ChainRow extends AuditChainRow {
  prevHash: Buffer | null;
  hash: Buffer;
}

export type ChainVerdict =
  { ok: true; checked: number } | { ok: false; checked: number; brokenId: string; problem: 'link' | 'hash' };

/** Reads raw columns (never audit.canonical()), so the check does not trust database functions. */
export async function readChainRows(
  client: pg.ClientBase,
  afterId: bigint,
  limit: number,
): Promise<ChainRow[]> {
  const { rows } = await client.query(
    // Qualified e.id in WHERE/ORDER BY: the text alias "id" would sort lexicographically (1, 10, 100, 2…).
    `select e.id::text as id,
            (extract(epoch from at) * 1000000)::bigint::text as at_micros,
            (extract(epoch from sim_at) * 1000000)::bigint::text as sim_at_micros,
            actor_user_id::text as actor_user_id, actor_kind, request_id, table_name, row_id, action,
            before::text as before_json, after::text as after_json, reason, prev_hash, hash
       from audit_event e where e.id > $1 order by e.id limit $2`,
    [afterId.toString(), limit],
  );
  return rows.map((r) => ({
    id: r.id,
    atMicros: r.at_micros,
    simAtMicros: r.sim_at_micros,
    actorUserId: r.actor_user_id,
    actorKind: r.actor_kind,
    requestId: r.request_id,
    tableName: r.table_name,
    rowId: r.row_id,
    action: r.action,
    beforeJson: r.before_json,
    afterJson: r.after_json,
    reason: r.reason,
    prevHash: r.prev_hash,
    hash: r.hash,
  }));
}

/** Walks the whole chain in id order; stops at the first event whose link or hash does not match. */
export async function verifyAuditChain(client: pg.ClientBase, batchSize = 1000): Promise<ChainVerdict> {
  let expectedPrev: Buffer | null = null;
  let afterId = 0n;
  let checked = 0;

  for (;;) {
    const batch = await readChainRows(client, afterId, batchSize);
    if (batch.length === 0) return { ok: true, checked };

    for (const row of batch) {
      const linked =
        row.prevHash === null ? expectedPrev === null : expectedPrev?.equals(row.prevHash) === true;
      if (!linked) return { ok: false, checked, brokenId: row.id, problem: 'link' };
      if (!chainHash(row.prevHash, row).equals(row.hash))
        return { ok: false, checked, brokenId: row.id, problem: 'hash' };
      expectedPrev = row.hash;
      afterId = BigInt(row.id);
      checked += 1;
    }
  }
}
