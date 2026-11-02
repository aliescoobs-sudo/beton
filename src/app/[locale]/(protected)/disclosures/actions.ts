'use server';

import { getPool } from '@/lib/db/pools';
import { decideDisclosure, requestDisclosure, viewDisclosure } from '@/modules/ledger';
import { authorize, ForbiddenError, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Failure = { ok: false; error: string };

// @permission disclosure.request (offices and plant): asks to see one figure of one item; nothing is shown until the owner or app_admin approves
export async function requestDisclosureAction(input: unknown): Promise<{ ok: true } | Failure> {
  const allowed = await authorize('disclosure.request', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  const r = await requestDisclosure(getPool('app'), allowed.user, input);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// @permission disclosure.request (offices and plant): the figure, once per allowed view, to the person it was approved for; the view is audited
export async function viewDisclosureAction(
  id: string,
): Promise<{ ok: true; centimes: number; viewsLeft: number | null } | Failure> {
  const allowed = await authorize('disclosure.request', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  const r = await viewDisclosure(getPool('app'), allowed.user, id);
  return r.ok
    ? { ok: true, centimes: r.value.centimes, viewsLeft: r.value.viewsLeft }
    : { ok: false, error: r.error };
}

// @permission disclosure.decide (owner, app_admin) + sensitive action disclosure.decide: approves a scoped disclosure (default one view, 15 minutes) or denies it
export async function decideDisclosureAction(input: unknown): Promise<{ ok: true } | Failure> {
  const allowed = await authorize('disclosure.decide', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await withStepUp(
      'disclosure.decide',
      (user) => decideDisclosure(getPool('app'), user, input),
      { getState: currentAuthState },
    );
    if (!result.ok) return { ok: false, error: result.error };
    return result.value.ok ? { ok: true } : { ok: false, error: result.value.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
