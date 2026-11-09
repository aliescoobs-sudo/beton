'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import type { Effect } from '@/modules/ledger';
import {
  confirmTripDelivered,
  confirmTripStage,
  correctTripStage,
  localMidnightMs,
  recordTripStep,
} from '@/modules/operations';
import { clockOf } from '@/modules/operations/domain/trip-times';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Failure = { ok: false; error: string };

// @permission trips.track (plant manager, owner, app_admin): one tap, one stage, with the clock's instant; the plant's load is made when it taps the load
export async function recordTripStepAction(input: unknown): Promise<
  | {
      ok: true;
      step: string;
      blNo: string | null;
      warnings: string[];
      effects: Effect[];
      recorded: boolean;
      by: { source: string; at: string; implicit: boolean; clock: string };
    }
  | Failure
> {
  const allowed = await authorize('trips.track', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const clock = await getRequestClock();
    const result = await recordTripStep(getPool('app'), allowed.user, input, {
      today: clock.today(),
      now: clock.now(),
    });
    return result.ok
      ? {
          ok: true as const,
          step: result.value.step,
          blNo: result.value.load?.blNo ?? null,
          warnings: result.value.load?.warnings ?? [],
          effects: result.value.effects,
          recorded: result.value.recorded,
          by: { ...result.value.by, clock: clockOf(result.value.by.at) },
        }
      : { ok: false as const, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission trips.correct (plant manager of the plant, owner, app_admin): the time of a recorded stage, a reason, a new row in the audit log
export async function correctTripStageAction(input: {
  tripId: string;
  step: string;
  date: string;
  time: string;
  reason: string;
}): Promise<{ ok: true } | Failure> {
  const allowed = await authorize('trips.correct', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(input.time ?? '');
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '')) return { ok: false, error: 'INVALID' };
  // the time is read as the business day's clock (Casablanca), as every other time of the board
  const at = new Date(
    localMidnightMs(input.date) + (Number(m[1]) * 60 + Number(m[2])) * 60_000,
  ).toISOString();
  try {
    const result = await correctTripStage(getPool('app'), allowed.user, {
      tripId: input.tripId,
      step: input.step,
      at,
      reason: input.reason,
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission trips.track (plant manager of the plant, owner, app_admin): the plant confirms the delivery a driver declared
export async function confirmTripDeliveredAction(input: { tripId: string }): Promise<{ ok: true } | Failure> {
  const allowed = await authorize('trips.track', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await confirmTripDelivered(getPool('app'), allowed.user, input);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission trips.track (plant manager of the plant, owner, app_admin): the plant confirms the departure or the return the driver declared
export async function confirmTripStageAction(input: {
  tripId: string;
  step: string;
}): Promise<{ ok: true } | Failure> {
  const allowed = await authorize('trips.track', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await confirmTripStage(getPool('app'), allowed.user, input, {
      now: (await getRequestClock()).now(),
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
