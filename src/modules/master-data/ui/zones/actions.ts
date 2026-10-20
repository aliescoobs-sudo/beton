'use server';

import { getPool } from '@/lib/db/pools';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';
import { createZone, updateZone, type ZoneError } from '../../service/zone-service';

export type ZoneActionResult =
  { ok: true } | { ok: false; error: 'UNAUTHENTICATED' | 'FORBIDDEN' | ZoneError };

async function writeAction(
  run: (user: Parameters<typeof createZone>[1]) => ReturnType<typeof createZone>,
): Promise<ZoneActionResult> {
  const allowed = await authorize('zones.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await run(allowed.user);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission zones.write (owner, partner)
export async function createZoneAction(input: unknown): Promise<ZoneActionResult> {
  return writeAction((user) => createZone(getPool('app'), user, input));
}

// @permission zones.write (owner, partner)
export async function updateZoneAction(id: unknown, input: unknown): Promise<ZoneActionResult> {
  if (typeof id !== 'string') return { ok: false, error: 'INVALID' };
  return writeAction((user) => updateZone(getPool('app'), user, id, input));
}
