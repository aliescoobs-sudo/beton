'use server';

import { getPool } from '@/lib/db/pools';
import { defaultFieldCipher } from '@/modules/master-data';
import {
  reschedulePumpJob,
  resolvePumpConflict,
  schedulePumpJob,
  setOrderPumped,
} from '@/modules/operations';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Result = { ok: true } | { ok: false; error: string };

async function guarded(
  run: (user: Parameters<typeof setOrderPumped>[1]) => Promise<Result>,
): Promise<Result> {
  const allowed = await authorize('pumps.plan', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    return await run(allowed.user);
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission pumps.plan (owner, app_admin, partner, offices, plant): a pour is pumped, so no truck is planned before a pump is on site
export async function markPumpedAction(input: { orderCode: string; pumped: boolean }): Promise<Result> {
  return guarded(async (user) => {
    const r = await setOrderPumped(getPool('app'), user, {
      orderCode: String(input.orderCode),
      pumped: input.pumped === true,
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });
}

// @permission pumps.plan: schedules a pump on site (a time, a set-up, a pumping duration); conflicts are raised at once
export async function schedulePumpAction(input: unknown): Promise<Result> {
  return guarded(async (user) => {
    const r = await schedulePumpJob(getPool('app'), user, input, defaultFieldCipher());
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });
}

// @permission pumps.plan: moves the time on site of a pump job that has not started
export async function reschedulePumpAction(input: { jobId: string; onSiteMin: number }): Promise<Result> {
  return guarded(async (user) => {
    const r = await reschedulePumpJob(getPool('app'), user, input);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });
}

// @permission pumps.plan: a conflict has been dealt with
export async function resolveConflictAction(input: { id: string }): Promise<Result> {
  return guarded(async (user) => {
    const r = await resolvePumpConflict(getPool('app'), user, String(input.id));
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });
}
