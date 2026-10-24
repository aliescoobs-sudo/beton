'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import type { Effect } from '@/modules/ledger';
import { createLoad, type DeliveryError, recordBlReturn } from '@/modules/operations';
import { authorize, ForbiddenError, type Permission } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Failure = { ok: false; error: DeliveryError | 'UNAUTHENTICATED' | 'FORBIDDEN' | string };

async function guarded<T>(
  permission: Permission,
  run: (user: Parameters<typeof createLoad>[1]) => Promise<T>,
): Promise<T | Failure> {
  const allowed = await authorize(permission, { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    return await run(allowed.user);
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission deliveries.write (plant, owner, partner): the result carries the BL number and quantities only
export async function createLoadAction(
  input: unknown,
): Promise<{ ok: true; blNo: string; volumeL: number; warnings: string[]; effects: Effect[] } | Failure> {
  return guarded('deliveries.write', async (user) => {
    const today = (await getRequestClock()).today();
    const result = await createLoad(getPool('app'), user, input, { today });
    return result.ok
      ? {
          ok: true as const,
          blNo: result.value.blNo,
          volumeL: result.value.volumeL,
          warnings: result.value.warnings,
          effects: result.value.effects,
        }
      : result;
  });
}

// @permission deliveries.bl_return (plant, office, owner, partner)
export async function blReturnAction(input: unknown): Promise<{ ok: true } | Failure> {
  return guarded('deliveries.bl_return', async (user) => {
    const result = await recordBlReturn(getPool('app'), user, input);
    return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
  });
}
