'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { saveCompanyProfile } from '@/modules/ledger';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission company.write (owner): a new version of our legal identity
export async function saveCompanyAction(input: unknown): Promise<{ ok: boolean; error?: string }> {
  const allowed = await authorize('company.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await saveCompanyProfile(getPool('app'), allowed.user, input, {
      today: (await getRequestClock()).today(),
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
