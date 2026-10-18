import { createHash } from 'node:crypto';

/** The audit_event columns covered by the hash chain, as text exactly as PostgreSQL renders them. */
export interface AuditChainRow {
  id: string;
  /** `at` as epoch microseconds (independent of the session time zone). */
  atMicros: string;
  simAtMicros: string | null;
  actorUserId: string;
  actorKind: string;
  requestId: string | null;
  tableName: string;
  rowId: string | null;
  action: string;
  /** `before::text` / `after::text` (jsonb text output is deterministic). */
  beforeJson: string | null;
  afterJson: string | null;
  reason: string | null;
}

function field(value: string | null): string {
  return value === null ? '-' : `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

/**
 * Unambiguous serialization: each field is `<utf8 byte length>:<value>` or `-` for NULL, joined by `|`.
 * Must match audit.canonical() in db/migrations/0003_audit_chain.sql (an integration test checks it).
 */
export function canonicalAuditEvent(row: AuditChainRow): string {
  return [
    row.id,
    row.atMicros,
    row.simAtMicros,
    row.actorUserId,
    row.actorKind,
    row.requestId,
    row.tableName,
    row.rowId,
    row.action,
    row.beforeJson,
    row.afterJson,
    row.reason,
  ]
    .map(field)
    .join('|');
}

/** hash = sha256(prev_hash || canonical); the first event has no prev_hash. */
export function chainHash(prevHash: Buffer | null, row: AuditChainRow): Buffer {
  const hash = createHash('sha256');
  if (prevHash) hash.update(prevHash);
  return hash.update(canonicalAuditEvent(row), 'utf8').digest();
}
