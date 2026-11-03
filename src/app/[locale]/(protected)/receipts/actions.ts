'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import type { Effect } from '@/modules/ledger';
import { defaultFileStore } from '@/lib/files/server-store';
import { attachArrivalFile, confirmArrivalAtPlant, recordReceipt } from '@/modules/operations';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission receipts.write (plant, owner, partner): the result carries the effects the role may see, no amount
export async function receiveAction(
  input: unknown,
): Promise<{ ok: true; effects: Effect[] } | { ok: false; error: string }> {
  const allowed = await authorize('receipts.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await recordReceipt(getPool('app'), allowed.user, input, {
      today: (await getRequestClock()).today(),
    });
    return result.ok ? { ok: true, effects: result.value.effects } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission receipts.confirm_arrival (plant, owner, partner): the first step of the two-step receipt, no quantity, no price
export async function confirmArrivalAction(input: {
  purchaseId: string;
  note?: string;
  lines?: { lineId: string; arrivedMilli: number; rejectedMilli: number; available: boolean }[];
}): Promise<{ ok: true; confirmationId?: string } | { ok: false; error: string }> {
  const allowed = await authorize('receipts.confirm_arrival', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await confirmArrivalAtPlant(getPool('app'), allowed.user, {
      purchaseId: String(input.purchaseId),
      note: input.note ?? null,
      lines: input.lines ?? [],
    });
    return result.ok
      ? { ok: true, confirmationId: result.value.confirmationId }
      : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission receipts.confirm_arrival (plant, owner, partner): the weighbridge ticket or delivery note of an arrival (checked, sealed)
export async function attachArrivalFileAction(
  data: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const allowed = await authorize('receipts.confirm_arrival', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  const file = data.get('file');
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'EMPTY' };
  try {
    const result = await attachArrivalFile(
      getPool('app'),
      allowed.user,
      {
        confirmationId: String(data.get('confirmationId') ?? ''),
        kind: String(data.get('kind') ?? '') as 'weighbridge_ticket' | 'delivery_note',
      },
      { declaredType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
      { store: defaultFileStore() },
    );
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
