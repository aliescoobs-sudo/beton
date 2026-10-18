import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import type { SessionUser } from '../auth/session-gate';

export interface AuditFilters {
  from?: Date;
  to?: Date;
  actorId?: string;
  table?: string;
  action?: string;
  reason?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditRow {
  id: string;
  at: Date;
  simAt: Date | null;
  actorUserId: string;
  actorKind: string;
  table: string;
  rowId: string | null;
  action: string;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

const MAX_PAGE_SIZE = 100;

/**
 * Audit events visible to `viewer`, newest first. Scoping is done by RLS under the viewer's own context (owner and
 * partner: all; office and plant: their own actions), so filters can only narrow it.
 */
export async function listAuditEvents(
  appPool: pg.Pool,
  viewer: SessionUser,
  filters: AuditFilters = {},
): Promise<{ rows: AuditRow[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(filters.pageSize ?? 50, 1), MAX_PAGE_SIZE);
  const page = Math.max(filters.page ?? 1, 1);
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (filters.from) add('at >= ?', filters.from);
  if (filters.to) add('at < ?', filters.to);
  if (filters.actorId) add('actor_user_id = ?::uuid', filters.actorId);
  if (filters.table) add('table_name = ?', filters.table);
  if (filters.action) add('action = ?', filters.action);
  if (filters.reason) add('reason = ?', filters.reason);
  const clause = where.length ? `where ${where.join(' and ')}` : '';

  return withRlsContext(
    appPool,
    { userId: viewer.id, role: viewer.role, requestId: uuidv7(realClock.now()) },
    async (tx) => {
      const {
        rows: [count],
      } = await tx.query<{ n: number }>(`select count(*)::int as n from audit_event ${clause}`, params);
      const { rows } = await tx.query(
        `select id::text, at, sim_at, actor_user_id::text, actor_kind, table_name, row_id, action, reason, before, after
         from audit_event ${clause} order by id desc limit $${params.length + 1} offset $${params.length + 2}`,
        [...params, pageSize, (page - 1) * pageSize],
      );
      return {
        rows: rows.map((r) => ({
          id: r.id,
          at: r.at,
          simAt: r.sim_at,
          actorUserId: r.actor_user_id,
          actorKind: r.actor_kind,
          table: r.table_name,
          rowId: r.row_id,
          action: r.action,
          reason: r.reason,
          before: r.before,
          after: r.after,
        })),
        total: count?.n ?? 0,
        page,
        pageSize,
      };
    },
  );
}
