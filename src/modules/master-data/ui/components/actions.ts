'use server';

import { getPool } from '@/lib/db/pools';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';
import {
  createComponent,
  createPurchaseUnit,
  updateComponent,
  updatePurchaseUnit,
  type ComponentError,
} from '../../service/component-service';

export type ComponentActionResult =
  { ok: true } | { ok: false; error: 'UNAUTHENTICATED' | 'FORBIDDEN' | ComponentError };

async function writeAction(
  run: (
    user: Parameters<typeof createComponent>[1],
  ) => Promise<{ ok: true } | { ok: false; error: ComponentError }>,
): Promise<ComponentActionResult> {
  const allowed = await authorize('components.write', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await run(allowed.user);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

const asStatus = (v: unknown) => (v === 'active' || v === 'archived' ? v : undefined);

// @permission components.write (owner, partner)
export async function createComponentAction(input: unknown): Promise<ComponentActionResult> {
  return writeAction((user) => createComponent(getPool('app'), user, input));
}

// @permission components.write (owner, partner)
export async function updateComponentAction(
  id: unknown,
  input: unknown,
  status?: unknown,
): Promise<ComponentActionResult> {
  if (typeof id !== 'string') return { ok: false, error: 'INVALID' };
  return writeAction((user) => updateComponent(getPool('app'), user, id, input, asStatus(status)));
}

// @permission components.write (owner, partner)
export async function createPurchaseUnitAction(
  componentId: unknown,
  input: unknown,
): Promise<ComponentActionResult> {
  if (typeof componentId !== 'string') return { ok: false, error: 'INVALID' };
  return writeAction((user) => createPurchaseUnit(getPool('app'), user, componentId, input));
}

// @permission components.write (owner, partner)
export async function updatePurchaseUnitAction(
  id: unknown,
  label: unknown,
  status?: unknown,
): Promise<ComponentActionResult> {
  if (typeof id !== 'string') return { ok: false, error: 'INVALID' };
  return writeAction((user) => updatePurchaseUnit(getPool('app'), user, id, label, asStatus(status)));
}
