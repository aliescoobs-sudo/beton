'use server';

import { getPool } from '@/lib/db/pools';
import { authorize, ForbiddenError, type Permission } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';
import {
  archiveSupplier,
  createSupplier,
  updateSupplier,
  type SupplierError,
} from '../../service/supplier-service';

export type SupplierActionResult =
  { ok: true } | { ok: false; error: 'UNAUTHENTICATED' | 'FORBIDDEN' | SupplierError };

async function guarded(
  permission: Permission,
  run: (
    user: Parameters<typeof createSupplier>[1],
  ) => Promise<{ ok: true } | { ok: false; error: SupplierError }>,
): Promise<SupplierActionResult> {
  const allowed = await authorize(permission, { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    return await run(allowed.user);
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

const done = (result: { ok: true; value: unknown } | { ok: false; error: SupplierError }) =>
  result.ok ? ({ ok: true } as const) : result;

// @permission parties.write (owner, partner, office)
export async function createSupplierAction(input: unknown): Promise<SupplierActionResult> {
  return guarded('parties.write', async (user) => done(await createSupplier(getPool('app'), user, input)));
}

// @permission parties.write (owner, partner, office)
export async function updateSupplierAction(id: unknown, input: unknown): Promise<SupplierActionResult> {
  if (typeof id !== 'string') return { ok: false, error: 'NOT_FOUND' };
  return guarded('parties.write', async (user) =>
    done(await updateSupplier(getPool('app'), user, id, input)),
  );
}

// @permission parties.archive (owner, partner)
export async function archiveSupplierAction(id: unknown): Promise<SupplierActionResult> {
  if (typeof id !== 'string') return { ok: false, error: 'NOT_FOUND' };
  return guarded('parties.archive', async (user) => done(await archiveSupplier(getPool('app'), user, id)));
}
