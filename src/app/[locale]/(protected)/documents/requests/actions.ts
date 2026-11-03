'use server';

import { revalidatePath } from 'next/cache';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import {
  decideDocumentRequest,
  requestDocument,
  setInvoiceSequence,
  setInvoiceTiming,
  releaseDocumentRequest,
} from '@/modules/ledger';
import { authorize, ForbiddenError, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Result = { ok: true } | { ok: false; error: string };
const off = (): Result | null => (getEnv().DOCUMENTS_V1_ENABLED ? null : { ok: false, error: 'NOT_FOUND' });
const done = (r: { ok: boolean; error?: string }): Result => {
  revalidatePath('/', 'layout');
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'ERROR' };
};

// @permission documents.request (offices and accountant): asks for a document a client or supplier requested; nothing leaves before approval
export async function requestDocumentAction(input: unknown): Promise<Result> {
  const blocked = off();
  if (blocked) return blocked;
  const allowed = await authorize('documents.request', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  return done(await requestDocument(getPool('app'), allowed.user, input));
}

// @permission documents.request (offices and accountant): the release of an approved request, once
export async function releaseDocumentRequestAction(id: string): Promise<Result> {
  const blocked = off();
  if (blocked) return blocked;
  const allowed = await authorize('documents.request', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  return done(await releaseDocumentRequest(getPool('app'), allowed.user, id));
}

// @permission documents.decide (owner, app_admin) + sensitive action documents.decide: approves or denies a document request
export async function decideDocumentRequestAction(input: unknown): Promise<Result> {
  const blocked = off();
  if (blocked) return blocked;
  const allowed = await authorize('documents.decide', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const r = await withStepUp(
      'documents.decide',
      (user) => decideDocumentRequest(getPool('app'), user, input),
      {
        getState: currentAuthState,
      },
    );
    if (!r.ok) return { ok: false, error: r.error };
    return done(r.value);
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission documents.policy (owner, app_admin, accountant): when the final invoice is issued
export async function setInvoiceTimingAction(timing: string): Promise<Result> {
  const blocked = off();
  if (blocked) return blocked;
  const allowed = await authorize('documents.policy', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  return done(await setInvoiceTiming(getPool('app'), allowed.user, timing));
}

// @permission documents.sequence (owner, app_admin): the company's last invoice number of the year; the numbering continues from it
export async function setInvoiceSequenceAction(input: { year: number; last: number }): Promise<Result> {
  const blocked = off();
  if (blocked) return blocked;
  const allowed = await authorize('documents.sequence', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  return done(await setInvoiceSequence(getPool('app'), allowed.user, input));
}
