import type { Auth } from './create-auth';
import type { UserRole } from './user-service';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  locale: 'fr' | 'ar';
  twoFactorEnabled: boolean;
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
 * (SPEC §5: 2FA is mandatory).
 */
export async function resolveAuthState(auth: Auth, headers: Headers): Promise<AuthState> {
  const result = await auth.api.getSession({ headers });
  if (!result) return { kind: 'anonymous' };

  const user: SessionUser = {
    id: result.user.id,
    name: result.user.name,
    email: result.user.email,
    role: result.user.role as UserRole,
    locale: result.user.locale === 'ar' ? 'ar' : 'fr',
    twoFactorEnabled: result.user.twoFactorEnabled === true,
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
