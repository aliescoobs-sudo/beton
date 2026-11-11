import { isTrainingEmail } from '@/lib/training';
import { realClock } from '@/modules/clock';
import { APIError } from 'better-auth/api';
import { isLoginRole } from '../domain/login-roles';
import type { Auth } from './create-auth';
import type { UserRole } from './user-service';
import type { UserLocale } from '../domain/locale';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  /** The plant this request acts in (a plant manager's own, or the one picked on a screen); not a right (R1). */
  plantId?: string | null;
  locale: UserLocale;
  twoFactorEnabled: boolean;
  /** Logged in with a recovery code: must enrol a new authenticator before any sensitive action. */
  reenrolRequired: boolean;
  /**
   * Set only by `withStepUp`, on the copy of the user it hands to the guarded action: this request passed the step-up (a second factor no
   * older than the policy, no re-enrolment pending). `inRequest` carries it to the database (`app.step_up`), whose sensitive doors refuse
   * a request without it, so a service reached by any other path cannot do what only a stepped-up action may.
   */
  stepUpVerified?: boolean;
  /** R18-05: set only for a phone session. `inRequest` carries it to the database, which fences every transaction against the live session. */
  fieldSession?: { driverId: string; deviceRowId: string; gen: number };
}

export interface SessionInfo {
  id: string;
  createdAt: Date;
  /** Last successful TOTP (or recovery code) for this session; step-up needs it to be recent. */
  twoFactorAt: Date | null;
}

export type AuthState =
  | { kind: 'anonymous' }
  | { kind: 'needs_enrolment'; user: SessionUser }
  | { kind: 'authenticated'; user: SessionUser; session: SessionInfo };

/**
 * The single answer to "who is this request?". A session whose user has not enrolled 2FA may only enrol
 * (SPEC §5: 2FA is mandatory). Sessions past the 12 h absolute lifetime are revoked by the auth hooks.
 */
export async function resolveAuthState(
  auth: Auth,
  headers: Headers,
  /** T1: the training instance. Only then may a training account (reserved address) work with a password alone. */
  opts: { trainingMode?: boolean } = {},
): Promise<AuthState> {
  let result;
  try {
    result = await auth.api.getSession({ headers });
  } catch (error) {
    if (error instanceof APIError) return { kind: 'anonymous' }; // e.g. past the 12 h absolute lifetime
    throw error;
  }
  if (!result) return { kind: 'anonymous' };
  // R17-03: a session that belongs to a reserved, unknown or missing role is not a session (also for one created before this rule)
  if (!isLoginRole((result.user as { role?: unknown }).role)) return { kind: 'anonymous' };

  const user: SessionUser = {
    id: result.user.id,
    name: result.user.name,
    email: result.user.email,
    role: result.user.role as UserRole,
    locale: result.user.locale === 'ar' ? 'ar' : 'fr',
    twoFactorEnabled: result.user.twoFactorEnabled === true,
    reenrolRequired: result.user.reenrolRequired === true,
  };
  const raw0 = result.session as { id: string; createdAt: Date | string };
  if (!user.twoFactorEnabled && opts.trainingMode === true && isTrainingEmail(user.email)) {
    // Training accounts have no authenticator: the password is the only factor, and a signed-in session counts as a fresh one so that
    // the sensitive actions can be practised. RBAC, RLS, the audit log and money visibility apply to them exactly as to anybody.
    return {
      kind: 'authenticated',
      user,
      session: { id: raw0.id, createdAt: new Date(raw0.createdAt), twoFactorAt: realClock.now() },
    };
  }
  if (!user.twoFactorEnabled) return { kind: 'needs_enrolment', user };

  const raw = result.session as { id: string; createdAt: Date | string; twoFactorAt?: Date | string | null };
  return {
    kind: 'authenticated',
    user,
    session: {
      id: raw.id,
      createdAt: new Date(raw.createdAt),
      twoFactorAt: raw.twoFactorAt ? new Date(raw.twoFactorAt) : null,
    },
  };
}
