'use server';

import { revalidatePath } from 'next/cache';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { closeDay } from '@/modules/operations';
import { authorize } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission dayclose.write (owner, app_admin, plant_manager): closes the day of a plant; blocking items stop it and tell the owner, who can close it knowingly with a note
export async function closeDayAction(formData: FormData): Promise<void> {
  if (!getEnv().TRANSFERS_ENABLED) return;
  const allowed = await authorize('dayclose.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return;
  await closeDay(getPool('app'), allowed.user, {
    plantId: String(formData.get('plantId')),
    date: String(formData.get('date')),
    force: formData.get('force') === 'on',
    note: String(formData.get('note') ?? '') || undefined,
  });
  revalidatePath('/', 'layout');
}
