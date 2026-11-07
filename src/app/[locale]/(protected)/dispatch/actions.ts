'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import {
  createDriver,
  postponeTrip,
  reassignTrip,
  saveDispatch,
  setTripEstimate,
  setTruckDefaultDriver,
} from '@/modules/operations';
import { authorize, ForbiddenError, type Permission } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Failure = { ok: false; error: string };

async function guarded<T>(
  permission: Permission,
  run: (user: Parameters<typeof saveDispatch>[1]) => Promise<T>,
): Promise<T | Failure> {
  const allowed = await authorize(permission, { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    return await run(allowed.user);
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission dispatch.write (plant, owner, partner): a day's rotations, quantities and times only
export async function saveDispatchAction(
  input: unknown,
): Promise<
  | { ok: true; rotations: number; conflicts: number; conflictKinds: string[]; overlapOverride: boolean }
  | Failure
> {
  return guarded('dispatch.write', async (user) => {
    const today = (await getRequestClock()).today();
    const result = await saveDispatch(getPool('app'), user, input, { today });
    return result.ok
      ? {
          ok: true as const,
          rotations: result.value.rotations,
          conflicts: result.value.conflicts.length,
          conflictKinds: [...new Set(result.value.conflicts.map((c) => c.kind))],
          overlapOverride: result.value.overlapOverride,
        }
      : { ok: false as const, error: result.error };
  });
}

// @permission drivers.write (owner, partner): a driver's name, the code is the next free CH-nn
export async function createDriverAction(input: unknown): Promise<{ ok: true } | Failure> {
  return guarded('drivers.write', async (user) => {
    const result = await createDriver(getPool('app'), user, input);
    return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
  });
}

// @permission drivers.write (owner, partner): the default driver of a truck, audited by the truck's own audit trigger
export async function setTruckDefaultDriverAction(input: {
  truckId: string;
  driverId: string | null;
}): Promise<{ ok: true } | Failure> {
  return guarded('drivers.write', async (user) => {
    const result = await setTruckDefaultDriver(getPool('app'), user, input);
    return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
  });
}

// @permission dispatch.write (plant manager of the plant, owner, app_admin): moves a rotation that has not started to another truck and driver, with a reason; recorded
export async function reassignTripAction(input: {
  tripId: string;
  truckId: string;
  driverId: string | null;
  reason: string;
  /** The reason of an explicit override, only when the new plan double-books a driver or a truck. */
  overlapReason?: string;
}): Promise<{ ok: true; conflicts: string[]; overlapOverride: boolean } | Failure> {
  return guarded('dispatch.write', async (user) => {
    const today = (await getRequestClock()).today();
    const result = await reassignTrip(getPool('app'), user, input, { today });
    return result.ok
      ? {
          ok: true as const,
          // What the new plan still has wrong is handed back to the screen, never dropped.
          conflicts: [...new Set(result.value.conflicts)],
          overlapOverride: result.value.overlapOverride,
        }
      : { ok: false as const, error: result.error };
  });
}

// @permission dispatch.write (plant manager of the plant, owner, app_admin): postpones a rotation that has not started, with a reason; recorded
export async function postponeTripAction(input: {
  tripId: string;
  reason: string;
}): Promise<{ ok: true } | Failure> {
  return guarded('dispatch.write', async (user) => {
    const result = await postponeTrip(getPool('app'), user, input);
    return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
  });
}

// @permission dispatch.write (plant manager of the plant, owner, app_admin): overrides the default estimate of a stage for a route, with a reason; audited
export async function setTripEstimateAction(input: {
  plantId: string;
  zoneId: string | null;
  stage: Parameters<typeof setTripEstimate>[2]['stage'];
  minutes: number;
  reason: string;
}): Promise<{ ok: true } | Failure> {
  return guarded('dispatch.write', async (user) => {
    const result = await setTripEstimate(getPool('app'), user, input);
    return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
  });
}
