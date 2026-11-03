'use server';

import { revalidatePath } from 'next/cache';
import { getPool } from '@/lib/db/pools';
import { setCreditLimit } from '@/modules/ledger';
import { authorize, ForbiddenError, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

/** "12 500,50" or "12500.5" to centimes by integer arithmetic only; anything else is refused. Empty means "remove the limit". */
export function madToCentimes(raw: string): number | null | 'INVALID' {
  const text = raw.replace(/[\s ]/g, '').replace(',', '.');
  if (text === '') return null;
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return 'INVALID';
  const centimes = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return centimes > 0 ? centimes : 'INVALID';
}

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
