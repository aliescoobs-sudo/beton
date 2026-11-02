import { APIError } from 'better-auth/api';
import type { Auth } from './create-auth';
import type { UserRole } from './user-service';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  /** The plant this request acts in (a plant manager's own, or the one picked on a screen); not a right (R1). */
  plantId?: string | null;
  locale: 'fr' | 'ar';
  twoFactorEnabled: boolean;
  /** Logged in with a recovery code: must enrol a new authenticator before any sensitive action. */
  reenrolRequired: boolean;
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
export async function resolveAuthState(auth: Auth, headers: Headers): Promise<AuthState> {
  let result;
  try {
    result = await auth.api.getSession({ headers });
  } catch (error) {
    if (error instanceof APIError) return { kind: 'anonymous' }; // e.g. past the 12 h absolute lifetime
    throw error;
  }
  if (!result) return { kind: 'anonymous' };

  const user: SessionUser = {
    id: result.user.id,
    name: result.user.name,
    email: result.user.email,
    role: result.user.role as UserRole,
    locale: result.user.locale === 'ar' ? 'ar' : 'fr',
    twoFactorEnabled: result.user.twoFactorEnabled === true,
    reenrolRequired: result.user.reenrolRequired === true,
  };
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
