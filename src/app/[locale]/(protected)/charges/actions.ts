'use server';

import { revalidatePath } from 'next/cache';
import { getPool } from '@/lib/db/pools';
import {
  addChargeDocument,
  type ChargeError,
  decideCharge,
  markChargePaid,
  recordCharge,
} from '@/modules/ledger';
import { authorize, type Permission } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Answer =
  { ok: true; withDocument?: boolean } | { ok: false; error: ChargeError | 'UNAUTHENTICATED' | 'FORBIDDEN' };

async function guarded(
  permission: Permission,
  run: (
    user: Parameters<typeof recordCharge>[1],
  ) => Promise<{ ok: true; value: unknown } | { ok: false; error: ChargeError }>,
): Promise<Answer> {
  const allowed = await authorize(permission, { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  const r = await run(allowed.user);
  if (!r.ok) return r;
  revalidatePath('/[locale]/charges', 'page');
  const v = r.value as { withDocument?: boolean } | true;
  return {
    ok: true,
    ...(typeof v === 'object' && 'withDocument' in v ? { withDocument: v.withDocument } : {}),
  };
}

// @permission charges.write (owner, app_admin, office_purchases): record a charge (the doors check the actor again)
export const recordChargeAction = (input: unknown) =>
  guarded('charges.write', (u) => recordCharge(getPool('app'), u, input));
// @permission charges.decide (owner, app_admin, office_sales): validate, approve or reject; nobody decides on their own preparation (the door)
export const decideChargeAction = (input: unknown) =>
  guarded('charges.decide', (u) => decideCharge(getPool('app'), u, input));
// @permission charges.write (owner, app_admin, office_purchases): mark paid once the control allows it; a missing document is flagged
export const payChargeAction = (input: unknown) =>
  guarded('charges.write', (u) => markChargePaid(getPool('app'), u, input));
// @permission charges.write (owner, app_admin, office_purchases): add the supporting document reference later
export const addDocumentAction = (input: unknown) =>
  guarded('charges.write', (u) => addChargeDocument(getPool('app'), u, input));
