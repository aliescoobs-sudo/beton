'use server';

import { getPool } from '@/lib/db/pools';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';
import { createRecetteVersion, type RecetteError } from '../../service/recette-service';

export type RecetteActionResult =
  { ok: true } | { ok: false; error: 'UNAUTHENTICATED' | 'FORBIDDEN' | RecetteError };

// @permission recettes.write (owner, partner)
export async function createRecetteVersionAction(
  concreteTypeId: unknown,
  input: unknown,
): Promise<RecetteActionResult> {
  if (typeof concreteTypeId !== 'string') return { ok: false, error: 'INVALID' };
  const allowed = await authorize('recettes.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await createRecetteVersion(getPool('app'), allowed.user, concreteTypeId, input);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
