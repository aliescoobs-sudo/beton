'use server';

import { revalidatePath } from 'next/cache';
import { getPool } from '@/lib/db/pools';
import {
  cancelReorderRequest,
  createReorderRequest,
  linkReorderToPurchase,
  markReorderSeen,
} from '@/modules/operations';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Answer = { ok: true } | { ok: false; error: string };
const deps = () => ({ getState: currentAuthState, appPool: getPool('app') });

// @permission reorder.create (plant_manager): a request for a component of his own plant; quantities only
export async function createReorderAction(input: unknown): Promise<Answer> {
  const allowed = await authorize('reorder.create', deps());
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const r = await createReorderRequest(getPool('app'), allowed.user, input);
    if (r.ok) revalidatePath('/reorders');
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission reorder.handle (office_purchases, owner, app_admin): mark a request seen
export async function seenReorderAction(requestId: string): Promise<Answer> {
  const allowed = await authorize('reorder.handle', deps());
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const r = await markReorderSeen(getPool('app'), allowed.user, String(requestId));
    if (r.ok) revalidatePath('/reorders');
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission reorder.handle (office_purchases, owner, app_admin): convert = link the request to an existing purchase code
export async function linkReorderAction(requestId: string, purchaseCode: string): Promise<Answer> {
  const allowed = await authorize('reorder.handle', deps());
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const r = await linkReorderToPurchase(
      getPool('app'),
      allowed.user,
      String(requestId),
      String(purchaseCode),
    );
    if (r.ok) revalidatePath('/reorders');
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission reorder.read (the door refuses everyone but the plant manager of the plant, owner and app_admin): cancel with a reason
export async function cancelReorderAction(requestId: string, reason: string): Promise<Answer> {
  const allowed = await authorize('reorder.read', deps());
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const r = await cancelReorderRequest(getPool('app'), allowed.user, String(requestId), String(reason));
    if (r.ok) revalidatePath('/reorders');
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
