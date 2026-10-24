import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import type { Role } from '../domain/permissions';
import { recordAuditEvent } from './audit-service';

/**
 * DECISIONS 81: every view of a money screen by the support role is audited ('view' on the screen's name). The
 * database cannot log plain reads, so each money page calls this before it reads anything. Other roles that can reach a
 * money screen (the owner) are not logged: the audit log would only grow.
 */
export async function recordMoneyView(
  pool: pg.Pool,
  actor: { id: string; role: Role },
  screen: string,
): Promise<void> {
  if (actor.role !== 'support') return;
  await withRlsContext(
    pool,
    { userId: actor.id, role: actor.role, requestId: uuidv7(realClock.now()) },
    (tx) => recordAuditEvent(tx, { action: 'view', table: screen }),
  );
}

/**
 * Every export of money data (a CSV of a statement, the accountant's files) is audited as `export`, for every role that
 * can do it (DECISIONS 82): the owner included, because what leaves the screen leaves the application.
 */
export async function recordMoneyExport(
  pool: pg.Pool,
  actor: { id: string; role: Role },
  what: string,
): Promise<void> {
  await withRlsContext(
    pool,
    { userId: actor.id, role: actor.role, requestId: uuidv7(realClock.now()) },
    (tx) => recordAuditEvent(tx, { action: 'export', table: what }),
  );
}
