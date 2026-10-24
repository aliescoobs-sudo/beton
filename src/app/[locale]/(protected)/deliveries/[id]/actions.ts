'use server';

import { getPool } from '@/lib/db/pools';
import { getDeliveryNote, recordNotePrint } from '@/modules/operations';
import { authorize } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission deliveries.read (every signed-in role): the print of a delivery note is audited
export async function printNoteAction(deliveryId: string): Promise<{ ok: boolean }> {
  const allowed = await authorize('deliveries.read', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false };
  const note = await getDeliveryNote(getPool('app'), allowed.user, deliveryId);
  if (!note) return { ok: false };
  await recordNotePrint(getPool('app'), allowed.user, note.blNo);
  return { ok: true };
}
