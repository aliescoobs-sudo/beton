'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import type { Effect } from '@/modules/ledger';
import { recordTripStep } from '@/modules/operations';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Failure = { ok: false; error: string };

// @permission trips.track (plant, owner, partner): one tap, one step, with the clock's instant; the first step is the load
export async function recordTripStepAction(
  input: unknown,
): Promise<{ ok: true; step: string; blNo: string | null; warnings: string[]; effects: Effect[] } | Failure> {
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
        }
      : { ok: false as const, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
