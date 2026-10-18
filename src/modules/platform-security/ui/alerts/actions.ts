'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getPool } from '@/lib/db/pools';
import { authorize } from '../../auth/guards';
import { currentAuthState } from '../../auth/request-state';
import { acknowledgeSecurityAlert } from '../../service/break-glass';

// @permission alerts.risk.read (owner, partner) — each acknowledges only for themselves (RLS)
export async function acknowledgeSecurityAlertAction(alertId: unknown): Promise<void> {
  const id = z.string().regex(/^\d+$/).safeParse(alertId);
  if (!id.success) return;
  const allowed = await authorize('alerts.risk.read', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return;
  await acknowledgeSecurityAlert(getPool('app'), allowed.user, id.data);
  revalidatePath('/', 'layout');
}
