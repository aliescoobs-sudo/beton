'use server';

import { getPool } from '@/lib/db/pools';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';
import {
  createConcreteType,
  updateConcreteType,
  type ConcreteTypeError,
} from '../../service/concrete-type-service';

export type ConcreteTypeActionResult =
  { ok: true } | { ok: false; error: 'UNAUTHENTICATED' | 'FORBIDDEN' | ConcreteTypeError };

async function writeAction(
  run: (
    user: Parameters<typeof createConcreteType>[1],
  ) => Promise<{ ok: true } | { ok: false; error: ConcreteTypeError }>,
): Promise<ConcreteTypeActionResult> {
  const allowed = await authorize('recettes.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await run(allowed.user);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission recettes.write (owner, partner)
export async function createConcreteTypeAction(input: unknown): Promise<ConcreteTypeActionResult> {
  return writeAction((user) => createConcreteType(getPool('app'), user, input));
}

// @permission recettes.write (owner, partner)
export async function updateConcreteTypeAction(
  id: unknown,
  label: unknown,
  status: unknown,
): Promise<ConcreteTypeActionResult> {
  if (typeof id !== 'string') return { ok: false, error: 'INVALID' };
  const next = status === 'active' || status === 'archived' ? status : undefined;
  return writeAction((user) => updateConcreteType(getPool('app'), user, id, label, next));
}
