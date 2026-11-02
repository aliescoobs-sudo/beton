'use server';

import { getPool } from '@/lib/db/pools';
import { instructDriver } from '@/modules/field';
import { defaultFieldCipher } from '@/modules/master-data';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission field.instruct (owner, app_admin, partner, office_sales, plant): tells the driver what to do after an emergency
export async function instructAction(input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const allowed = await authorize('field.instruct', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const r = await instructDriver(getPool('app'), allowed.user, input, defaultFieldCipher());
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
