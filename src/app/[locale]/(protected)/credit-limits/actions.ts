'use server';

import { revalidatePath } from 'next/cache';
import { getPool } from '@/lib/db/pools';
import { madToCentimes } from './money';
import { setCreditLimit } from '@/modules/ledger';
import { authorize, ForbiddenError, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission credit_limit.write (owner, app_admin) + sensitive action credit_limit.set: sets or removes a client's credit limit
export async function setCreditLimitAction(formData: FormData): Promise<void> {
  const allowed = await authorize('credit_limit.write', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return;
  const limit = madToCentimes(String(formData.get('limit') ?? ''));
  if (limit === 'INVALID') return;
  try {
    await withStepUp(
      'credit_limit.set',
      (user) =>
        setCreditLimit(getPool('app'), user, {
          clientId: String(formData.get('clientId')),
          limitCentimes: limit,
        }),
      { getState: currentAuthState },
    );
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error;
  }
  revalidatePath('/', 'layout');
}
