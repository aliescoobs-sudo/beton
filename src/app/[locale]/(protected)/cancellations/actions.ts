'use server';

import { revalidatePath } from 'next/cache';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import {
  cancelUnproducedOrder,
  decideCancellation,
  listRedirectCandidates,
  openTripCase,
  setCancellationPolicy,
  type RedirectCandidate,
} from '@/modules/operations';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Result = { ok: true } | { ok: false; error: string };
const deps = { getState: currentAuthState, appPool: () => getPool('app') };

async function run(
  permission: 'cancellations.open' | 'cancellations.decide' | 'cancellations.policy' | 'cancellations.read',
  fn: (
    user: Parameters<typeof cancelUnproducedOrder>[1],
    now: Date,
  ) => Promise<{ ok: boolean; error?: string }>,
): Promise<Result> {
  if (!getEnv().CANCELLATIONS_ENABLED) return { ok: false, error: 'NOT_FOUND' };
  const allowed = await authorize(permission, { getState: deps.getState, appPool: deps.appPool() });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const r = await fn(allowed.user, (await getRequestClock()).now());
    revalidatePath('/', 'layout');
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'ERROR' };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission cancellations.open (owner, app_admin, partner, office, office_sales, plant, plant_manager): cases 1 and 2
export async function cancelOrderCaseAction(input: { orderId: string; reason?: string }): Promise<Result> {
  return run('cancellations.open', (user, now) =>
    cancelUnproducedOrder(getPool('app'), user, input, { today: now.toISOString().slice(0, 10) }),
  );
}

// @permission cancellations.open (owner, app_admin, partner, office, office_sales, plant, plant_manager): cases 3 to 7
export async function openTripCaseAction(input: {
  tripId: string;
  caseNo: number;
  reason?: string;
  unloadedL?: number;
  sampleTaken?: boolean;
}): Promise<Result> {
  return run('cancellations.open', (user, now) => openTripCase(getPool('app'), user, input, { now }));
}

// @permission cancellations.decide (owner, app_admin, plant_manager): redirect or loss, the plant manager only under the policy
export async function decideCaseAction(input: Parameters<typeof decideCancellation>[2]): Promise<Result> {
  return run('cancellations.decide', (user, now) => decideCancellation(getPool('app'), user, input, { now }));
}

// @permission cancellations.policy (owner, app_admin): who decides and whether the cancelling client is charged
export async function setPolicyAction(input: {
  plantMayDecide: boolean;
  clientCharged: boolean;
}): Promise<Result> {
  return run('cancellations.policy', (user) => setCancellationPolicy(getPool('app'), user, input));
}

// @permission cancellations.read (every company role): the orders that could take the surplus of a case
export async function candidatesAction(caseId: string): Promise<RedirectCandidate[]> {
  if (!getEnv().CANCELLATIONS_ENABLED) return [];
  const allowed = await authorize('cancellations.read', { getState: deps.getState, appPool: deps.appPool() });
  if (!allowed.ok) return [];
  return listRedirectCandidates(getPool('app'), allowed.user, caseId, {
    now: (await getRequestClock()).now(),
  });
}
