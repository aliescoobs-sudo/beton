'use server';

import { getPool } from '@/lib/db/pools';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';
import { createPlant, type PlantError, updatePlant } from '../../service/plant-service';

export type PlantActionResult =
  { ok: true } | { ok: false; error: 'UNAUTHENTICATED' | 'FORBIDDEN' | PlantError };

async function writeAction(
  run: (user: Parameters<typeof createPlant>[1]) => ReturnType<typeof createPlant>,
): Promise<PlantActionResult> {
  const allowed = await authorize('plants.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await run(allowed.user);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission plants.write (owner, partner)
export async function createPlantAction(input: unknown): Promise<PlantActionResult> {
  return writeAction((user) => createPlant(getPool('app'), user, input));
}

// @permission plants.write (owner, partner): rename or archive; a plant is never deleted
export async function updatePlantAction(id: unknown, changes: unknown): Promise<PlantActionResult> {
  if (typeof id !== 'string' || typeof changes !== 'object' || changes === null) {
    return { ok: false, error: 'INVALID' };
  }
  const c = changes as { name?: unknown; status?: unknown };
  const name = typeof c.name === 'string' ? c.name : undefined;
  const status = c.status === 'active' || c.status === 'archived' ? c.status : undefined;
  return writeAction((user) => updatePlant(getPool('app'), user, id, { name, status }));
}
