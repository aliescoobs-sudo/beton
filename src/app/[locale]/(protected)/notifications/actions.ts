'use server';

import { revalidatePath } from 'next/cache';
import { getPool } from '@/lib/db/pools';
import { authorize, markRead, sendTestNotification } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission notifications.read (every signed-in account): marks the caller's own notifications as read
export async function markAllReadAction(): Promise<void> {
  const allowed = await authorize('notifications.read', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return;
  await markRead(getPool('app'), allowed.user, null);
  revalidatePath('/', 'layout');
}

// @permission notifications.read (every signed-in account): sends the caller a test notification (to check the phone)
export async function sendTestAction(): Promise<void> {
  const allowed = await authorize('notifications.read', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return;
  await sendTestNotification(getPool('app'), allowed.user);
  revalidatePath('/', 'layout');
}
