import { createHmac, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { realClock } from '@/modules/clock';
import {
  ANONYMOUS_ACTOR_ID,
  type Auth,
  createUser,
  inRequest,
  require,
  type SessionUser,
} from '@/modules/platform-security';
import { auditAuthEvent } from '@/modules/platform-security/auth/audit';
import { parseLoginPin, parsePin, PIN_LOCK_MINUTES, PIN_MAX_FAILED } from '../domain/pin';
import { FIELD_SESSION_DAYS, hashDeviceId, signFieldToken } from './session';

export interface FieldAuthDeps {
  appPool: pg.Pool;
  authPool: pg.Pool;
  auth: Auth;
  /** AUTH_SECRET: the PIN is peppered and the session signed with keys derived from it. */
  secret: string;
}

const actorOf = (u: SessionUser) => ({ userId: u.id, role: u.role });
const pepper = (secret: string, driverId: string, pin: string) =>
  createHmac('sha256', secret).update(`pin:${driverId}:${pin}`).digest('hex');

/** Gives a driver or pump operator a user of the right role (no password anybody knows), linked to the driver. Owner and app_admin. */
export async function createFieldAccount(
  deps: FieldAuthDeps,
  admin: SessionUser,
  driverId: string,
): Promise<Result<{ userId: string }, 'NOT_FOUND' | 'ALREADY'>> {
  await require(deps.appPool, admin, 'field.admin');
  const found = await inRequest(deps.appPool, admin, (tx) =>
    tx.query<{
      id: string;
      code: string;
      name: string;
      kind: 'driver' | 'pump_operator';
      user_id: string | null;
    }>(`select id, code, name, kind, user_id from driver where id = $1 and status = 'active'`, [driverId]),
  ).catch(() => null);
  const d = found?.rows[0];
  if (!d) return err('NOT_FOUND');
  if (d.user_id) return err('ALREADY');
  const created = await createUser(deps.auth, deps.authPool, {
    actor: actorOf(admin),
    email: `${d.code.toLowerCase()}@field.kayas.invalid`,
    name: d.name,
    // Nobody knows this password: the phone signs in with its PIN, never through the password form.
    password: randomBytes(24).toString('base64url'),
    role: d.kind,
    locale: 'ar',
  });
  await inRequest(deps.appPool, admin, (tx) =>
    tx.query('update driver set user_id = $2 where id = $1', [driverId, created.id]),
  );
  return ok({ userId: created.id });
}

/** Sets (or resets) the PIN of a driver. The PIN is hashed (Argon2id over a keyed digest) and never stored or logged. */
export async function setDriverPin(
  deps: FieldAuthDeps,
  admin: SessionUser,
  input: { driverId: string; pin: unknown },
): Promise<Result<true, 'INVALID' | 'TOO_EASY' | 'NO_ACCOUNT'>> {
  await require(deps.appPool, admin, 'field.admin');
  const pin = parsePin(input.pin);
  if (!pin.ok) return err(pin.error);
  const done = await deps.authPool.query<{ ok: boolean }>('select public.field_set_pin($1, $2, $3) as ok', [
    input.driverId,
    await hash(pepper(deps.secret, input.driverId, pin.value)),
    admin.id,
  ]);
  if (!done.rows[0]?.ok) return err('NO_ACCOUNT');
  await auditAuthEvent(deps.authPool, actorOf(admin), {
    action: 'two_factor_enrolled',
    table: 'driver_pin',
    rowId: input.driverId,
    reason: 'pin_set',
  });
  return ok(true);
}

/** The bound phone is released (lost, replaced): the next sign-in binds the new one. Owner and app_admin. */
export async function revokeDriverDevice(
  deps: FieldAuthDeps,
  admin: SessionUser,
  driverId: string,
): Promise<boolean> {
  await require(deps.appPool, admin, 'field.admin');
  const r = await deps.authPool.query<{ ok: boolean }>('select public.field_revoke_device($1, $2) as ok', [
    driverId,
    admin.id,
  ]);
  if (r.rows[0]?.ok) {
    await auditAuthEvent(deps.authPool, actorOf(admin), {
      action: 'session_revoked',
      table: 'driver_device',
      rowId: driverId,
      reason: 'device_released',
    });
  }
  return r.rows[0]?.ok === true;
}

export interface FieldAccount {
  driverId: string;
  code: string;
  name: string;
  kind: 'driver' | 'pump_operator';
  hasAccount: boolean;
  hasPin: boolean;
  lockedUntil: string | null;
  deviceLabel: string | null;
  deviceBoundAt: string | null;
}

export async function listFieldAccounts(deps: FieldAuthDeps, admin: SessionUser): Promise<FieldAccount[]> {
  await require(deps.appPool, admin, 'field.admin');
  const { rows } = await deps.authPool.query<{
    driver_id: string;
    code: string;
    name: string;
    kind: 'driver' | 'pump_operator';
    user_id: string | null;
    has_pin: boolean;
    locked_until: Date | null;
    device_label: string | null;
    device_bound_at: Date | null;
  }>('select * from public.field_accounts()');
  return rows.map((r) => ({
    driverId: r.driver_id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    hasAccount: r.user_id !== null,
    hasPin: r.has_pin,
    lockedUntil: r.locked_until && r.locked_until > realClock.now() ? r.locked_until.toISOString() : null,
    deviceLabel: r.device_label,
    deviceBoundAt: r.device_bound_at?.toISOString() ?? null,
  }));
}

export type LoginError = 'INVALID' | 'WRONG' | 'LOCKED' | 'OTHER_DEVICE';
// A hash to verify when the code is unknown, so an unknown code and a wrong PIN take the same time.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0MBXbUjDqkJRK3yrWNHkCxY4SnLJ4/4cgEwIyxVNhqs';

type Outcome =
  | { kind: 'unknown' }
  | { kind: 'locked'; driverId: string }
  | { kind: 'wrong'; driverId: string; locksNow: boolean }
  | { kind: 'other_device'; driverId: string }
  | { kind: 'in'; driverId: string; userId: string; role: 'driver' | 'pump_operator'; bound: boolean };

/**
 * The phone's sign-in: the driver code, the PIN, and the phone's own id. Five wrong PINs lock the driver for fifteen minutes;
 * a phone other than the bound one is refused until the owner or app_admin releases the first. Every outcome is audited.
 *
 * F11: the lock check, the PIN check, the failure count and the issue of the session are ONE serialised step per driver. The
 * transaction takes the driver's PIN row `FOR UPDATE` and keeps it until commit, so parallel attempts queue behind each other and
 * each one sees the count the previous one left (no parallel bypass of the five), and a correct PIN that arrives after the lock
 * cannot clear it. The database re-checks the lock when it issues the success (`field_login_ok`). An attempt that cannot get the
 * row within three seconds is told "locked" rather than left waiting.
 */
export async function loginDriver(
  deps: FieldAuthDeps,
  input: { code: unknown; pin: unknown; deviceId: unknown; deviceLabel?: unknown },
  now: Date,
): Promise<Result<{ token: string; kind: 'driver' | 'pump_operator'; maxAgeSeconds: number }, LoginError>> {
  const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
  const device =
    typeof input.deviceId === 'string' && input.deviceId.length >= 16 && input.deviceId.length <= 100
      ? input.deviceId
      : null;
  const pin = parseLoginPin(input.pin);
  if (!/^CH-\d{2,4}$/.test(code) || !device || !pin.ok) {
    // Same time as a real attempt, same answer as a wrong PIN: nothing tells a bad shape from a bad PIN.
    await verify(DUMMY_HASH, 'x').catch(() => false);
    return err('INVALID');
  }
  const fail = async (reason: string, driverId?: string) =>
    auditAuthEvent(
      deps.authPool,
      { userId: ANONYMOUS_ACTOR_ID, role: 'anonymous' },
      {
        action: 'login_failed',
        table: 'driver',
        rowId: driverId,
        reason,
      },
    );
  const deviceHash = hashDeviceId(deps.secret, device);
  const label = typeof input.deviceLabel === 'string' ? input.deviceLabel : '';

  let outcome: Outcome;
  const client = await deps.authPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '3s'");
    const found = await client.query<{
      driver_id: string;
      user_id: string;
      kind: 'driver' | 'pump_operator';
      pin_hash: string;
      locked_until: Date | null;
    }>('select driver_id, user_id, kind, pin_hash, locked_until from public.field_login_lock($1)', [code]);
    const row = found.rows[0];
    if (!row) {
      await verify(DUMMY_HASH, 'x').catch(() => false);
      outcome = { kind: 'unknown' };
    } else if (row.locked_until && row.locked_until > now) {
      outcome = { kind: 'locked', driverId: row.driver_id };
    } else {
      const good = await verify(row.pin_hash, pepper(deps.secret, row.driver_id, pin.value)).catch(
        () => false,
      );
      if (!good) {
        const failed = await client.query<{ n: number }>(
          'select public.field_login_failed($1, $2, $3) as n',
          [row.driver_id, PIN_MAX_FAILED, PIN_LOCK_MINUTES],
        );
        outcome = {
          kind: 'wrong',
          driverId: row.driver_id,
          locksNow: (failed.rows[0]?.n ?? 0) >= PIN_MAX_FAILED,
        };
      } else {
        const bound = await client.query<{ r: 'bound' | 'known' | 'other_device' | 'locked' }>(
          'select public.field_login_ok($1, $2, $3) as r',
          [row.driver_id, deviceHash, label],
        );
        const r = bound.rows[0]?.r;
        outcome =
          r === 'other_device'
            ? { kind: 'other_device', driverId: row.driver_id }
            : r === 'bound' || r === 'known'
              ? {
                  kind: 'in',
                  driverId: row.driver_id,
                  userId: row.user_id,
                  role: row.kind,
                  bound: r === 'bound',
                }
              : { kind: 'locked', driverId: row.driver_id };
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Could not take the driver's row in time: another attempt is running. Nothing was counted; the answer is "locked".
    if ((error as { code?: string }).code === '55P03') return err('LOCKED');
    throw error;
  } finally {
    client.release();
  }

  switch (outcome.kind) {
    case 'unknown':
      await fail('unknown_driver');
      return err('WRONG');
    case 'locked':
      await fail('locked', outcome.driverId);
      return err('LOCKED');
    case 'wrong':
      await fail('wrong_pin', outcome.driverId);
      if (outcome.locksNow) {
        await auditAuthEvent(
          deps.authPool,
          { userId: ANONYMOUS_ACTOR_ID, role: 'anonymous' },
          { action: 'account_locked', table: 'driver', rowId: outcome.driverId },
        );
        return err('LOCKED');
      }
      return err('WRONG');
    case 'other_device':
      await fail('other_device', outcome.driverId);
      return err('OTHER_DEVICE');
    case 'in': {
      await auditAuthEvent(
        deps.authPool,
        { userId: outcome.userId, role: outcome.role },
        {
          action: 'login',
          table: 'driver',
          rowId: outcome.driverId,
          reason: outcome.bound ? 'device_bound' : 'known_device',
        },
      );
      const maxAgeSeconds = FIELD_SESSION_DAYS * 86_400;
      // T10c: a new session supersedes the earlier token of this phone; the logout moves the generation again
      const opened = await deps.authPool.query<{ gen: number | null }>(
        'select public.field_session_open($1, $2) as gen',
        [outcome.driverId, deviceHash],
      );
      const gen = opened.rows[0]?.gen;
      if (typeof gen !== 'number') return err('LOCKED');
      return ok({
        kind: outcome.role,
        maxAgeSeconds,
        token: signFieldToken(deps.secret, {
          driverId: outcome.driverId,
          deviceHash,
          gen,
          exp: Math.floor(now.getTime() / 1000) + maxAgeSeconds,
        }),
      });
    }
  }
}

/** Every request of the phone: the token is valid, and the database still knows this driver and this phone. */
export async function sessionOfToken(
  deps: Pick<FieldAuthDeps, 'authPool'>,
  token: { driverId: string; deviceHash: string; gen: number },
): Promise<SessionUser | null> {
  const { rows } = await deps.authPool.query<{ user_id: string; kind: 'driver' | 'pump_operator' }>(
    'select user_id, kind from public.field_session_check($1, $2, $3)',
    [token.driverId, token.deviceHash, token.gen],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.user_id,
    name: '',
    email: '',
    role: r.kind,
    locale: 'ar',
    twoFactorEnabled: false,
    reenrolRequired: false,
  };
}

/** T10c: ends the session of this token on the server, so that no copy of it works any more. True when it was the live one; never an error for "nothing to end". */
export async function closeFieldSession(
  deps: Pick<FieldAuthDeps, 'authPool'>,
  token: { driverId: string; deviceHash: string; gen: number },
): Promise<boolean> {
  const { rows } = await deps.authPool.query<{ closed: boolean }>(
    'select public.field_session_close($1, $2, $3) as closed',
    [token.driverId, token.deviceHash, token.gen],
  );
  return rows[0]?.closed === true;
}
