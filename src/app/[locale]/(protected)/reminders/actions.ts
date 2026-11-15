'use server';

import { revalidatePath } from 'next/cache';
import { getPool } from '@/lib/db/pools';
import { logClientReminder, type ReminderError } from '@/modules/ledger';
import { authorize } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission reminders.write (owner, app_admin, office_sales): a reminder is a NOTE in the log; nothing is sent to the client
export async function logReminderAction(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: ReminderError | 'UNAUTHENTICATED' | 'FORBIDDEN' }> {
  const allowed = await authorize('reminders.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  const result = await logClientReminder(getPool('app'), allowed.user, input);
  if (!result.ok) return result;
  revalidatePath('/[locale]/reminders', 'page');
  return { ok: true };
}
