'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { createSupplierInvoice, type Effect, type SupplierInvoiceError } from '@/modules/ledger';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Failure = { ok: false; error: SupplierInvoiceError | 'UNAUTHENTICATED' | 'FORBIDDEN' };

// @permission supplier_invoices.write (owner, office): blind entry, the answer is our code and the effects the role may see
export async function createSupplierInvoiceAction(
  input: unknown,
): Promise<{ ok: true; code: string; effects: Effect[] } | Failure> {
  const allowed = await authorize('supplier_invoices.write', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await createSupplierInvoice(getPool('app'), allowed.user, input, {
      today: (await getRequestClock()).today(),
    });
    return result.ok ? { ok: true, code: result.value.code, effects: result.value.effects } : result;
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
