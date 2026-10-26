'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { defaultFileStore } from '@/lib/files/server-store';
import type { Effect } from '@/modules/ledger';
import {
  attachDeliveryScan,
  cancelLoad,
  createLoad,
  type DeliveryError,
  markDelivered,
  recordBlReturn,
  recordBlReturnWithScan,
  recordLoss,
  type ScanUpload,
} from '@/modules/operations';
import { authorize, ForbiddenError, type Permission, withStepUp } from '@/modules/platform-security';
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

/** The file field of a form, as the bytes and the type the browser declared; null when none was chosen. */
async function uploadOf(data: FormData): Promise<ScanUpload | null> {
  const file = data.get('file');
  if (!(file instanceof File) || file.size === 0) return null;
  return { declaredType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
}

// @permission deliveries.bl_return (plant, office, owner, partner): the signed BL comes back, with its scan when one is chosen
export async function blReturnWithScanAction(data: FormData): Promise<{ ok: true } | Failure> {
  return guarded('deliveries.bl_return', async (user) => {
    const upload = await uploadOf(data);
    const result = await recordBlReturnWithScan(
      getPool('app'),
      user,
      {
        deliveryId: String(data.get('deliveryId') ?? ''),
        returnedOn: String(data.get('returnedOn') ?? ''),
        returnedVolumeL: 0,
      },
      upload,
      { store: defaultFileStore() },
    );
    return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
  });
}

// @permission delivery_files.write (plant, office, owner, partner): the scan of a BL whose signed return is recorded
export async function attachScanAction(data: FormData): Promise<{ ok: true } | Failure> {
  return guarded('delivery_files.write', async (user) => {
    const upload = await uploadOf(data);
    if (!upload) return { ok: false as const, error: 'EMPTY' };
    const result = await attachDeliveryScan(
      getPool('app'),
      user,
      { deliveryId: String(data.get('deliveryId') ?? '') },
      upload,
      { store: defaultFileStore() },
    );
    return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
  });
}

// @permission deliveries.deliver (plant, owner, partner): a load made outside a rotation is delivered, now
export async function markDeliveredAction(input: unknown): Promise<{ ok: true } | Failure> {
  return guarded('deliveries.deliver', async (user) => {
    const now = (await getRequestClock()).now();
    const result = await markDelivered(getPool('app'), user, input, { now });
    return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
  });
}

// @permission deliveries.cancel (owner, partner) + sensitive action load.cancel: a reversing load and the stock back
export async function cancelLoadAction(input: unknown): Promise<{ ok: true } | Failure> {
  const allowed = await authorize('deliveries.cancel', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const today = (await getRequestClock()).today();
    const result = await withStepUp(
      'load.cancel',
      (user) => cancelLoad(getPool('app'), user, input, { today }),
      { getState: currentAuthState },
    );
    if (!result.ok) return { ok: false, error: result.error };
    return result.value.ok ? { ok: true } : { ok: false, error: result.value.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission deliveries.loss (plant, office, owner, partner): concrete that came back or was refused, with a reason
export async function recordLossAction(input: unknown): Promise<{ ok: true } | Failure> {
  return guarded('deliveries.loss', async (user) => {
    const result = await recordLoss(getPool('app'), user, input);
    return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
  });
}
