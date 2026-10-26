'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { defaultFileStore } from '@/lib/files/server-store';
import {
  acceptSupplierInvoiceGaps,
  approveSupplierInvoice,
  attachSupplierInvoiceFile,
  createSupplierInvoice,
  type DecisionError,
  type DocumentUpload,
  type Effect,
  rejectSupplierInvoice,
  type SupplierInvoiceError,
} from '@/modules/ledger';
import { authorize, ForbiddenError, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Failure = { ok: false; error: SupplierInvoiceError | 'UNAUTHENTICATED' | 'FORBIDDEN' };

/** The file field of a form, as the bytes and the type the browser declared; null when none was chosen. */
async function uploadOf(data: FormData): Promise<DocumentUpload | null> {
  const file = data.get('file');
  if (!(file instanceof File) || file.size === 0) return null;
  return { declaredType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
}

// @permission supplier_invoices.write (owner, office): blind entry, the answer is our code and the effects the role may see;
// the photo or PDF of the invoice, when chosen, is checked and sealed with it
export async function createSupplierInvoiceAction(
  data: FormData,
): Promise<{ ok: true; code: string; effects: Effect[] } | Failure> {
  const allowed = await authorize('supplier_invoices.write', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    let payload: unknown = null;
    try {
      payload = JSON.parse(String(data.get('payload') ?? 'null'));
    } catch {
      return { ok: false, error: 'INVALID' };
    }
    const upload = await uploadOf(data);
    const result = await createSupplierInvoice(
      getPool('app'),
      allowed.user,
      payload,
      { today: (await getRequestClock()).today() },
      upload ? { upload, store: defaultFileStore() } : null,
    );
    return result.ok ? { ok: true, code: result.value.code, effects: result.value.effects } : result;
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission supplier_invoices.write (owner, office): adds a photo or a PDF to an invoice by our code; blind, a yes or a no
export async function attachSupplierInvoiceFileAction(data: FormData): Promise<{ ok: true } | Failure> {
  const allowed = await authorize('supplier_invoices.write', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const upload = await uploadOf(data);
    if (!upload) return { ok: false, error: 'EMPTY' };
    const result = await attachSupplierInvoiceFile(
      getPool('app'),
      allowed.user,
      { code: String(data.get('code') ?? '') },
      upload,
      { store: defaultFileStore() },
    );
    return result.ok ? { ok: true } : result;
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

type DecisionResult =
  | { ok: true; effects?: Effect[] }
  | {
      ok: false;
      error: DecisionError | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'STEP_UP_REQUIRED' | 'REENROL_REQUIRED';
    };

// @permission supplier_invoices.approve (owner) + sensitive action purchases.approve_invoice: accepts the gaps, with a reason (audited)
export async function acceptGapsAction(input: unknown): Promise<DecisionResult> {
  const allowed = await authorize('supplier_invoices.approve', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await withStepUp(
      'purchases.approve_invoice',
      (user) => acceptSupplierInvoiceGaps(getPool('app'), user, input),
      { getState: currentAuthState },
    );
    if (!result.ok) return { ok: false, error: result.error };
    return result.value.ok ? { ok: true } : { ok: false, error: result.value.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission supplier_invoices.approve (owner) + sensitive action purchases.approve_invoice: approve for payment, creating the payable
export async function approveAction(input: unknown): Promise<DecisionResult> {
  const allowed = await authorize('supplier_invoices.approve', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await withStepUp(
      'purchases.approve_invoice',
      (user) => approveSupplierInvoice(getPool('app'), user, input),
      { getState: currentAuthState },
    );
    if (!result.ok) return { ok: false, error: result.error };
    return result.value.ok
      ? { ok: true, effects: result.value.value.effects }
      : { ok: false, error: result.value.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission supplier_invoices.approve (owner): rejects an invoice not approved yet, with a reason
export async function rejectAction(input: unknown): Promise<DecisionResult> {
  const allowed = await authorize('supplier_invoices.approve', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await rejectSupplierInvoice(getPool('app'), allowed.user, input);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
