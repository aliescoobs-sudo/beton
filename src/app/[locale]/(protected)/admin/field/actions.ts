'use server';

import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { createFieldAccount, revokeDriverDevice, setDriverPin } from '@/modules/field';
import { authorize, ForbiddenError, getAuth, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Failure = { ok: false; error: string };
const deps = () => ({
  appPool: getPool('app'),
  authPool: getPool('auth'),
  auth: getAuth(),
  secret: getEnv().AUTH_SECRET,
});

async function admin<T>(
  run: (user: Parameters<typeof createFieldAccount>[1]) => Promise<T>,
): Promise<{ ok: true; value: T } | Failure> {
  const allowed = await authorize('field.admin', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await withStepUp('users.manage', (user) => run(user), { getState: currentAuthState });
    return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission field.admin (owner, app_admin) + sensitive action users.manage: an account for a driver or pump operator
export async function createFieldAccountAction(driverId: string): Promise<{ ok: true } | Failure> {
  const r = await admin((user) => createFieldAccount(deps(), user, String(driverId)));
  if (!r.ok) return r;
  return r.value.ok ? { ok: true } : { ok: false, error: r.value.error };
}

// @permission field.admin (owner, app_admin) + sensitive action users.manage: the driver's PIN (never shown again)
export async function setPinAction(input: {
  driverId: string;
  pin: string;
}): Promise<{ ok: true } | Failure> {
  const r = await admin((user) =>
    setDriverPin(deps(), user, { driverId: String(input.driverId), pin: input.pin }),
  );
  if (!r.ok) return r;
  return r.value.ok ? { ok: true } : { ok: false, error: r.value.error };
}

// @permission field.admin (owner, app_admin) + sensitive action users.manage: releases the bound phone
export async function revokeDeviceAction(driverId: string): Promise<{ ok: true } | Failure> {
  const r = await admin((user) => revokeDriverDevice(deps(), user, String(driverId)));
  return r.ok ? { ok: true } : r;
}
