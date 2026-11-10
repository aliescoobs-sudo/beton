import { USER_ROLES } from './permissions';

/**
 * T10a (R17-03, decision 205/207): the roles an account may SIGN IN with. `partner` and `support` are reserved (no accounts in V1); an unknown,
 * empty or missing role is not a role at all. A positive list, so a role added to USER_ROLES later is not silently admitted to a gate that
 * forgot it: it has to be named in `RESERVED_ROLES` (refused) or stay in this list.
 */
export const RESERVED_ROLES = ['partner', 'support'] as const;
export const LOGIN_ROLES: readonly string[] = USER_ROLES.filter(
  (r) => !(RESERVED_ROLES as readonly string[]).includes(r),
);

export function isLoginRole(role: unknown): boolean {
  return typeof role === 'string' && LOGIN_ROLES.includes(role);
}
