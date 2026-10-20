'use server';

import { getPool } from '@/lib/db/pools';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';
import { createSite, updateSite, type SiteError } from '../../service/site-service';

export type SiteActionResult =
  { ok: true } | { ok: false; error: 'UNAUTHENTICATED' | 'FORBIDDEN' | SiteError };

async function writeAction(
  run: (user: Parameters<typeof createSite>[1]) => ReturnType<typeof createSite>,
): Promise<SiteActionResult> {
  const allowed = await authorize('parties.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await run(allowed.user);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission parties.write (owner, partner, office)
export async function createSiteAction(clientId: unknown, input: unknown): Promise<SiteActionResult> {
  if (typeof clientId !== 'string') return { ok: false, error: 'NOT_FOUND' };
  return writeAction((user) => createSite(getPool('app'), user, clientId, input));
}

// @permission parties.write (owner, partner, office)
export async function updateSiteAction(id: unknown, input: unknown): Promise<SiteActionResult> {
  if (typeof id !== 'string') return { ok: false, error: 'NOT_FOUND' };
  return writeAction((user) => updateSite(getPool('app'), user, id, input));
}
