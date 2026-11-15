import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';

/**
 * The client reminder (relance) log (T19 item 2, D245). A reminder is a NOTE that somebody phoned or wrote to a client about money owed:
 * KAYAS sends nothing. Written by the door log_client_reminder, read by client_reminder_list (owner, app_admin, office_sales; the doors check
 * the actor first, the permission here only gives the page its 404).
 */
export interface ReminderView {
  id: string;
  clientId: string;
  clientCode: string;
  clientName: string;
  note: string;
  createdAt: string;
  byName: string | null;
}

export type ReminderError = 'INVALID' | 'NOT_FOUND';

const schema = z.object({ clientId: z.uuid(), note: z.string().trim().min(3).max(500) });

export async function logClientReminder(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, ReminderError>> {
  await require(appPool, actor, 'reminders.write');
  const p = schema.safeParse(input);
  if (!p.success) return err<ReminderError>('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>('select public.log_client_reminder($1, $2) as id', [
        p.data.clientId,
        p.data.note,
      ]),
    );
    return ok({ id: rows[0]!.id });
  } catch (error) {
    if ((error as { code?: string }).code === '23514') return err<ReminderError>('NOT_FOUND');
    throw error;
  }
}

/** The newest reminders (all clients, or one), newest first. */
export async function listClientReminders(
  appPool: pg.Pool,
  actor: SessionUser,
  clientId: string | null = null,
  limit = 500,
): Promise<ReminderView[]> {
  await require(appPool, actor, 'reminders.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      o_id: string;
      o_client_id: string;
      o_client_code: string;
      o_client_name: string;
      o_note: string;
      o_created_at: Date;
      o_by_name: string | null;
    }>('select * from public.client_reminder_list($1::uuid, $2::int)', [clientId, limit]),
  );
  return rows.map((r) => ({
    id: r.o_id,
    clientId: r.o_client_id,
    clientCode: r.o_client_code,
    clientName: r.o_client_name,
    note: r.o_note,
    createdAt: r.o_created_at.toISOString(),
    byName: r.o_by_name,
  }));
}
