import { headers } from 'next/headers';
import { getAuth } from './instance';
import { type AuthState, resolveAuthState } from './session-gate';

/** Auth state of the current Next.js request (server components, route handlers, server actions). */
export async function currentAuthState(): Promise<AuthState> {
  return resolveAuthState(getAuth(), await headers());
}
