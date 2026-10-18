'use server';

import { z } from 'zod';
import { getPool } from '@/lib/db/pools';
import { authorize } from '../../auth/guards';
import { getAuth } from '../../auth/instance';
import { currentAuthState } from '../../auth/request-state';
import type { SessionUser } from '../../auth/session-gate';
import { withStepUp } from '../../auth/step-up-guard';
import {
  createManagedUser,
  resetTwoFactor,
  setUserStatus,
  type UserAdminDeps,
} from '../../service/user-admin';

export type AdminActionResult =
  | { ok: true }
  | {
      ok: false;
      error: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'STEP_UP_REQUIRED' | 'REENROL_REQUIRED' | 'INVALID';
      message?: string;
    };

const deps = (): UserAdminDeps => ({ auth: getAuth(), authPool: getPool('auth'), appPool: getPool('app') });

/** users.manage (owner) + sensitive action (fresh TOTP). Layers 1 and 2: the service checks the role again. */
async function ownerAction(fn: (user: SessionUser) => Promise<void>): Promise<AdminActionResult> {
  const allowed = await authorize('users.manage', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await withStepUp('users.manage', fn, { getState: currentAuthState });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    // Service refusals (policy, duplicates): their messages carry no secrets.
    return { ok: false, error: 'INVALID', message: error instanceof Error ? error.message : undefined };
  }
}

const newUserSchema = z.object({
  email: z.email(),
  name: z.string().trim().min(1).max(120),
  role: z.enum(['partner', 'office', 'plant']),
  locale: z.enum(['fr', 'ar']),
  password: z.string().min(1).max(128),
});

// @permission users.manage
export async function createUserAction(input: unknown): Promise<AdminActionResult> {
  const parsed = newUserSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'INVALID' };
  return ownerAction(async (user) => {
    await createManagedUser(deps(), user, parsed.data);
  });
}

const userId = z.uuid();

// @permission users.manage
export async function setUserStatusAction(id: unknown, status: unknown): Promise<AdminActionResult> {
  const parsed = z.object({ id: userId, status: z.enum(['active', 'disabled']) }).safeParse({ id, status });
  if (!parsed.success) return { ok: false, error: 'INVALID' };
  return ownerAction((user) => setUserStatus(deps(), user, parsed.data.id, parsed.data.status));
}

// @permission users.manage
export async function resetTwoFactorAction(id: unknown): Promise<AdminActionResult> {
  const parsed = userId.safeParse(id);
  if (!parsed.success) return { ok: false, error: 'INVALID' };
  return ownerAction((user) => resetTwoFactor(deps(), user, parsed.data));
}
