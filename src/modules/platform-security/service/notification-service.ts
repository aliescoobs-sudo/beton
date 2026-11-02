import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import type { SessionUser } from '../auth/session-gate';
import { inRequest } from './request';
import type { NotificationKind, NotificationSeverity } from '../domain/notification-catalogue';

// R5: the person's own notification centre. Every read is the caller's own rows (row-level security), the bell count is one
// reviewed door, and a push subscription is registered and dropped by its owner only.

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  params: Record<string, string | number | boolean | null>;
  link: string | null;
  createdAt: string;
  read: boolean;
}

export async function listMyNotifications(
  appPool: pg.Pool,
  actor: SessionUser,
  limit = 50,
): Promise<NotificationView[]> {
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      kind: NotificationKind;
      severity: NotificationSeverity;
      params: NotificationView['params'];
      link: string | null;
      created_at: Date;
      read_at: Date | null;
    }>('select * from public.my_notifications($1)', [limit]),
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    severity: r.severity,
    params: r.params,
    link: r.link,
    createdAt: r.created_at.toISOString(),
    read: r.read_at !== null,
  }));
}

export async function unreadCount(appPool: pg.Pool, actor: SessionUser): Promise<number> {
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ n: number }>('select public.unread_notification_count() as n'),
  );
  return rows[0]?.n ?? 0;
}

/** Marks the given notifications (or all of the caller's) as read. Only the caller's own rows can change. */
export async function markRead(appPool: pg.Pool, actor: SessionUser, ids: string[] | null): Promise<number> {
  const parsed = z.array(z.uuid()).max(200).nullable().safeParse(ids);
  if (!parsed.success) return 0;
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ n: number }>('select public.mark_notifications_read($1) as n', [parsed.data]),
  );
  return rows[0]?.n ?? 0;
}

export async function sendTestNotification(appPool: pg.Pool, actor: SessionUser): Promise<void> {
  await inRequest(appPool, actor, (tx) => tx.query('select public.send_test_notification()'));
}

const subscriptionInput = z.object({
  endpoint: z.url().max(1000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});

export type PushError = 'INVALID';

export async function saveSubscription(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<true, PushError>> {
  const p = subscriptionInput.safeParse(input);
  if (!p.success) return err('INVALID');
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query('select public.save_push_subscription($1, $2, $3)', [
        p.data.endpoint,
        p.data.keys.p256dh,
        p.data.keys.auth,
      ]),
    );
    return ok(true);
  } catch (error) {
    // the endpoint is not a push service of a browser (database check)
    if ((error as { code?: string }).code === '23514') return err('INVALID');
    throw error;
  }
}

export async function dropSubscription(
  appPool: pg.Pool,
  actor: SessionUser,
  endpoint: string,
): Promise<boolean> {
  if (!z.url().max(1000).safeParse(endpoint).success) return false;
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ d: boolean }>('select public.drop_push_subscription($1) as d', [endpoint]),
  );
  return rows[0]?.d ?? false;
}
