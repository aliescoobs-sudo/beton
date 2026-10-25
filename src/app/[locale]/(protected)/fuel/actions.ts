'use server';

import { getPool } from '@/lib/db/pools';
import { recordFuelFill, recordFuelPurchase } from '@/modules/operations';
import { authorize, ForbiddenError, type Permission } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Result = { ok: boolean; error?: string };

async function guarded(
  permission: Permission,
  run: (user: Parameters<typeof recordFuelFill>[1]) => Promise<Result>,
): Promise<Result> {
  const allowed = await authorize(permission, { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    return await run(allowed.user);
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission fuel.write (plant, owner, partner): litres put in a truck, quantities only
export async function recordFuelFillAction(input: unknown): Promise<Result> {
  return guarded('fuel.write', async (user) => {
    const r = await recordFuelFill(getPool('app'), user, input);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });
}

// @permission fuel.purchase (owner): fuel bought, litres and the total paid (money)
export async function recordFuelPurchaseAction(input: unknown): Promise<Result> {
  return guarded('fuel.purchase', async (user) => {
    const r = await recordFuelPurchase(getPool('app'), user, input);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });
}
