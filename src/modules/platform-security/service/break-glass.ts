import pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import { SYSTEM_ACTOR_ID } from '../auth/actors';
import { auditAuthEvent } from '../auth/audit';
import type { SessionUser } from '../auth/session-gate';
import { can } from '../domain/permissions';
import { clearTwoFactor } from './user-admin';

export interface BreakGlassDeps {
  /** Superuser URL typed by the operator: proves server-side access (DECISIONS 75). */
  adminUrl: string;
  authPool: pg.Pool;
  systemPool: pg.Pool;
}

const system = { userId: SYSTEM_ACTOR_ID, role: 'system' as const };

/** The stored text of the alert: a fixed sentence, never built from data (it names no client, amount or balance). */
export const OWNER_2FA_RESET_DETAIL = 'Owner 2FA reset with user:reset-owner-2fa';

async function assertSuperuser(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const { rows } = await client.query<{ su: string }>(`select current_setting('is_superuser') as su`);
    if (rows[0]?.su !== 'on') throw new Error('not a superuser');
  } catch {
    throw new Error('The database superuser password is required');
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Owner break-glass: resets the owner's 2FA when the owner lost both the authenticator and the recovery codes.
 * Server-only, needs the superuser password, audited, and raises an alert for the owner and the partner.
 */
export async function resetOwnerTwoFactor(deps: BreakGlassDeps): Promise<{ ownerId: string }> {
  await assertSuperuser(deps.adminUrl);
  const { rows } = await deps.authPool.query<{ id: string }>(`select id from "user" where role = 'owner'`);
  const ownerId = rows[0]?.id;
  if (!ownerId) throw new Error('There is no owner account');

  await clearTwoFactor(deps.authPool, ownerId);
  await auditAuthEvent(deps.authPool, system, {
    action: 'two_factor_reset',
    table: 'user',
    rowId: ownerId,
    reason: 'break_glass_cli',
  });
  await withRlsContext(deps.systemPool, { ...system, requestId: uuidv7(realClock.now()) }, (tx) =>
    tx.query(`insert into security_alert (kind, at, detail) values ('owner_2fa_reset', $1, $2)`, [
      realClock.now(),
      OWNER_2FA_RESET_DETAIL,
    ]),
  );
  return { ownerId };
}

export interface SecurityAlert {
  id: string;
  kind: 'owner_2fa_reset';
  at: Date;
}

/** Alerts this owner/partner has not acknowledged yet (others: none). */
export async function pendingSecurityAlerts(appPool: pg.Pool, user: SessionUser): Promise<SecurityAlert[]> {
  if (!can(user.role, 'alerts.risk.read')) return [];
  return withRlsContext(
    appPool,
    { userId: user.id, role: user.role, requestId: uuidv7(realClock.now()) },
    async (tx) => {
      const { rows } = await tx.query<{ id: string; kind: 'owner_2fa_reset'; at: Date }>(
        `select a.id::text, a.kind, a.at from security_alert a
        where not exists (select 1 from security_alert_ack k where k.alert_id = a.id and k.user_id = ctx.user_id())
        order by a.id`,
      );
      return rows;
    },
  );
}

export async function acknowledgeSecurityAlert(
  appPool: pg.Pool,
  user: SessionUser,
  alertId: string,
): Promise<void> {
  await withRlsContext(
    appPool,
    { userId: user.id, role: user.role, requestId: uuidv7(realClock.now()) },
    (tx) =>
      tx.query(
        `insert into security_alert_ack (alert_id, user_id, at) values ($1, $2, $3) on conflict do nothing`,
        [alertId, user.id, realClock.now()],
      ),
  );
}
