import type pg from 'pg';
import { type RlsContext, withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import { recordAuditEvent, type ServiceAuditEvent } from '../service/audit-service';

export type AuthActor = Pick<RlsContext, 'userId' | 'role'>;

/** Records an auth service event in its own transaction on the auth pool. */
export async function auditAuthEvent(
  pool: pg.Pool,
  actor: AuthActor,
  event: ServiceAuditEvent,
): Promise<void> {
  await withRlsContext(pool, { ...actor, requestId: uuidv7(realClock.now()) }, (tx) =>
    recordAuditEvent(tx, event),
  );
}
