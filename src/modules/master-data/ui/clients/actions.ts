'use server';

import { getPool } from '@/lib/db/pools';
import { authorize, type Permission, type SessionUser, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';
import {
  archiveClient,
  createClient,
  findClientByIce,
  updateClient,
  type ClientError,
  type ClientRef,
} from '../../service/client-service';

export type ClientActionResult =
  | { ok: true; id: string; similar: ClientRef[] }
  | {
      ok: false;
      error: 'UNAUTHENTICATED' | 'FORBIDDEN' | ClientError;
      /** The client already holding the ICE, so the form can point at it. */
      existing?: ClientRef;
    };

type Guarded<T> = { ok: true; value: T } | { ok: false; reason: 'UNAUTHENTICATED' | 'FORBIDDEN' };

async function guarded<T>(
  permission: Permission,
  run: (user: SessionUser) => Promise<T>,
): Promise<Guarded<T>> {
  const allowed = await authorize(permission, { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, reason: allowed.reason };
  try {
    return { ok: true, value: await run(allowed.user) };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, reason: 'FORBIDDEN' };
    throw error;
  }
}

async function saved(
  user: SessionUser,
  input: unknown,
  result: Awaited<ReturnType<typeof createClient>>,
): Promise<ClientActionResult> {
  if (result.ok) return { ok: true, id: result.value.client.id, similar: result.value.similar };
  if (result.error !== 'DUPLICATE_ICE') return { ok: false, error: result.error };
  const ice = typeof input === 'object' && input !== null ? (input as { ice?: unknown }).ice : undefined;
  const existing = typeof ice === 'string' ? await findClientByIce(getPool('app'), user, ice) : null;
  return { ok: false, error: 'DUPLICATE_ICE', ...(existing ? { existing } : {}) };
}

// @permission parties.write (owner, partner, office)
export async function createClientAction(input: unknown): Promise<ClientActionResult> {
  const outcome = await guarded('parties.write', async (user) =>
    saved(user, input, await createClient(getPool('app'), user, input)),
  );
  return outcome.ok ? outcome.value : { ok: false, error: outcome.reason };
}

// @permission parties.write (owner, partner, office)
export async function updateClientAction(id: unknown, input: unknown): Promise<ClientActionResult> {
  if (typeof id !== 'string') return { ok: false, error: 'INVALID' };
  const outcome = await guarded('parties.write', async (user) =>
    saved(user, input, await updateClient(getPool('app'), user, id, input)),
  );
  return outcome.ok ? outcome.value : { ok: false, error: outcome.reason };
}

// @permission parties.archive (owner, partner)
export async function archiveClientAction(
  id: unknown,
): Promise<{ ok: true } | { ok: false; error: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' }> {
  if (typeof id !== 'string') return { ok: false, error: 'NOT_FOUND' };
  const outcome = await guarded('parties.archive', (user) => archiveClient(getPool('app'), user, id));
  if (!outcome.ok) return { ok: false, error: outcome.reason };
  return outcome.value.ok ? { ok: true } : { ok: false, error: outcome.value.error };
}
