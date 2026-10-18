import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import { auditDenied } from '../auth/guards';
import type { SessionUser } from '../auth/session-gate';
import {
  defaultParameters,
  isParameterKey,
  type ParameterKey,
  type ParameterValues,
  parseParameter,
} from '../domain/parameters';
import { can } from '../domain/permissions';
import { ForbiddenError } from './user-admin';

/**
 * Current values: stored ones over the defaults. Read through belgobeton_auth (no session needed: the login lockout
 * uses them). A stored value that no longer passes its schema falls back to the default.
 */
export async function readParameters(authPool: pg.Pool): Promise<ParameterValues> {
  const values = defaultParameters();
  const { rows } = await authPool.query<{ key: string; value: unknown }>('select key, value from parameter');
  for (const row of rows) {
    if (!isParameterKey(row.key)) continue;
    const parsed = parseParameter(row.key, row.value);
    if (parsed.ok) (values as Record<string, unknown>)[row.key] = parsed.value;
  }
  return values;
}

/** Owner-only, validated, audited (capture trigger: before/after). Partners read; nobody else sees the page. */
export async function setParameter<K extends ParameterKey>(
  appPool: pg.Pool,
  actor: SessionUser,
  key: K,
  value: unknown,
): Promise<void> {
  if (!can(actor.role, 'parameters.write')) {
    await auditDenied(appPool, actor, 'parameters.write');
    throw new ForbiddenError();
  }
  const parsed = parseParameter(key, value);
  if (!parsed.ok) throw new Error(`Invalid value for ${key}`);

  await withRlsContext(
    appPool,
    { userId: actor.id, role: actor.role, requestId: uuidv7(realClock.now()) },
    (tx) =>
      tx.query(
        `insert into parameter (key, value, updated_by, updated_at) values ($1, $2, $3, $4)
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [key, JSON.stringify(parsed.value), actor.id, realClock.now()],
      ),
  );
}
