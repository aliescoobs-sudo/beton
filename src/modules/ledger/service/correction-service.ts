import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';
import { parseCorrectionInput } from '../domain/correction';

export interface CorrectionRequest {
  id: string;
  documentCode: string;
  reason: string;
  requestedBy: string;
  createdAt: Date;
}

/**
 * Office (or the owner) asks for a correction of a document it entered. The request carries the document code and a
 * reason and nothing else; it returns only its own id: the caller cannot read the table back, and an unknown code is
 * accepted like a real one, so a request reveals nothing about the ledger (DECISIONS 81).
 */
export async function requestCorrection(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, 'INVALID'>> {
  await require(appPool, actor, 'corrections.request');
  const parsed = parseCorrectionInput(input);
  if (!parsed.ok) return err('INVALID');
  const id = randomUUID();
  await inRequest(appPool, actor, (tx) =>
    // No RETURNING: office has no SELECT policy on the table.
    tx.query(
      `insert into correction_request (id, document_code, reason, requested_by) values ($1, $2, $3, $4)`,
      [id, parsed.value.documentCode, parsed.value.reason, actor.id],
    ),
  );
  return ok({ id });
}

/** The queue for the owner (and support, read-only), newest first. */
export async function listCorrectionRequests(
  appPool: pg.Pool,
  actor: SessionUser,
): Promise<CorrectionRequest[]> {
  await require(appPool, actor, 'corrections.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ id: string; document_code: string; reason: string; requested_by: string; created_at: Date }>(
      `select id, document_code, reason, requested_by, created_at from correction_request order by created_at desc, id`,
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    documentCode: r.document_code,
    reason: r.reason,
    requestedBy: r.requested_by,
    createdAt: r.created_at,
  }));
}
