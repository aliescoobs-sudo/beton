'use server';

import { getPool } from '@/lib/db/pools';
import { authorize, setMyLocale } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission account.locale (every signed-in account): sets the caller's own main language (fr, ar, ary)
export async function setMyLocaleAction(locale: string): Promise<{ ok: boolean }> {
  const allowed = await authorize('account.locale', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false };
  const r = await setMyLocale(getPool('app'), allowed.user, locale);
  return { ok: r.ok };
}
