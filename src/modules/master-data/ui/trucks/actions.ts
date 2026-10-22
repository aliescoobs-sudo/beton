'use server';

import { getPool } from '@/lib/db/pools';
import { authorize, ForbiddenError, type Permission } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';
import { createTruck, logTruckStatus, updateTruck, type TruckError } from '../../service/truck-service';

export type TruckActionResult =
  { ok: true } | { ok: false; error: 'UNAUTHENTICATED' | 'FORBIDDEN' | TruckError };

async function run(
  permission: Permission,
  action: (
    user: Parameters<typeof createTruck>[1],
  ) => Promise<{ ok: true } | { ok: false; error: TruckError }>,
): Promise<TruckActionResult> {
  const allowed = await authorize(permission, { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await action(allowed.user);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission trucks.write (owner, partner)
export async function createTruckAction(input: unknown): Promise<TruckActionResult> {
  return run('trucks.write', (user) => createTruck(getPool('app'), user, input));
}

// @permission trucks.write (owner, partner)
export async function updateTruckAction(
  id: unknown,
  input: unknown,
  status: unknown,
): Promise<TruckActionResult> {
  if (typeof id !== 'string') return { ok: false, error: 'INVALID' };
  const next = status === 'active' || status === 'archived' ? status : undefined;
  return run('trucks.write', (user) => updateTruck(getPool('app'), user, id, input, next));
}

// @permission trucks.status.write (plant)
export async function logTruckStatusAction(input: unknown): Promise<TruckActionResult> {
  return run('trucks.status.write', (user) => logTruckStatus(getPool('app'), user, input));
}
