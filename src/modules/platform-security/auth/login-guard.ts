import { isIP } from 'node:net';
import type pg from 'pg';
import { keyedHash } from '@/lib/crypto/hmac';
import type { Clock } from '@/modules/clock';

import type { ParameterValues } from '../domain/parameters';

export interface LoginGuardDeps {
  pool: pg.Pool; // belgobeton_auth
  hmacKey: string;
  clock: Clock;
  /** Current parameters (SPEC §5 defaults: 5 per account, 20 per IP, 15 minutes). */
  parameters: () => Promise<ParameterValues>;
}

export type LoginVerdict = 'allowed' | 'account_locked' | 'ip_locked';

/** Login identifiers are emails; compared case- and space-insensitively. */
export function normalizeIdentifier(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * Client IP for the per-IP lockout. X-Forwarded-For is attacker-controlled except for what the trusted proxies
 * append, so with `trustedHops` = 0 the header is ignored, and otherwise only the entry the outermost trusted proxy
 * appended is used: the `trustedHops`-th from the right. Earlier entries are whatever the client claimed. Null when
 * unknown or not an IP address: the per-IP limit is then skipped (never applied to everyone at once); the
 * per-account limit always applies.
 */
export function clientIp(headers: Headers | undefined, trustedHops: number): string | null {
  if (trustedHops < 1) return null;
  const hops = headers?.get('x-forwarded-for')?.split(',') ?? [];
  const ip = hops[hops.length - trustedHops]?.trim();
  return ip && isIP(ip) ? ip : null;
}

const hashes = (deps: LoginGuardDeps, identifier: string, ip: string | null) => ({
  identifierHmac: keyedHash(deps.hmacKey, `id:${identifier}`),
  ipHmac: keyedHash(deps.hmacKey, `ip:${ip ?? 'unknown'}`),
});

/** Failures since the last success inside the window; attempts made while locked are never recorded. */
export async function checkLogin(
  deps: LoginGuardDeps,
  identifier: string,
  ip: string | null,
): Promise<LoginVerdict> {
  const { identifierHmac, ipHmac } = hashes(deps, identifier, ip);
  const p = await deps.parameters();
  const since = new Date(deps.clock.now().getTime() - p['auth.lockout_window_minutes'] * 60_000);
  const { rows } = await deps.pool.query<{ account_failures: number; ip_failures: number }>(
    `select
       (select count(*)::int from login_attempt a
         where a.identifier_hmac = $1 and not a.success and a.at > $3
           and a.at > coalesce((select max(s.at) from login_attempt s where s.identifier_hmac = $1 and s.success), '-infinity'))
         as account_failures,
       (select count(*)::int from login_attempt where ip_hmac = $2 and not success and at > $3) as ip_failures`,
    [identifierHmac, ipHmac, since],
  );
  const { account_failures, ip_failures } = rows[0]!;
  if (account_failures >= p['auth.lockout_account_failures']) return 'account_locked';
  if (ip !== null && ip_failures >= p['auth.lockout_ip_failures']) return 'ip_locked';
  return 'allowed';
}

/**
 * R11-01: the per-IP limit alone, for the phone sign-in (its account limit is the driver's own atomic lock). True when this
 * IP already has `auth.lockout_ip_failures` failures inside the window. Skipped (false) when the IP is unknown.
 */
export async function ipIsLocked(deps: LoginGuardDeps, ip: string | null): Promise<boolean> {
  if (ip === null) return false;
  const p = await deps.parameters();
  const since = new Date(deps.clock.now().getTime() - p['auth.lockout_window_minutes'] * 60_000);
  const { rows } = await deps.pool.query<{ n: number }>(
    `select count(*)::int as n from login_attempt where ip_hmac = $1 and not success and at > $2`,
    [keyedHash(deps.hmacKey, `ip:${ip}`), since],
  );
  return (rows[0]?.n ?? 0) >= p['auth.lockout_ip_failures'];
}

/**
 * R12-03: admission for the phone sign-in. One attempt is RESERVED per IP before any expensive work (Argon2), in one transaction under
 * an advisory lock for that IP, so parallel requests are counted one after the other and the limit cannot be overshot by a burst. Every
 * attempt that is not released afterwards counts: a wrong PIN, one that locks the driver, an unknown code, a bad shape, a foreign phone.
 * An unknown or malformed IP shares one "unknown" bucket (fail closed: never "not locked"). The field namespace (`fieldip:`) keeps these
 * rows apart from the office sign-in's counters. Returns false when the IP has used its attempts for the window.
 */
export async function reserveFieldAttempt(deps: LoginGuardDeps, ip: string | null): Promise<boolean> {
  const hmac = keyedHash(deps.hmacKey, `fieldip:${ip ?? 'unknown'}`);
  const p = await deps.parameters();
  const now = deps.clock.now();
  const since = new Date(now.getTime() - p['auth.lockout_window_minutes'] * 60_000);
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `fieldip:${hmac.toString('hex')}`,
    ]);
    const { rows } = await client.query<{ used: number }>(
      `select (count(*) filter (where not success) - count(*) filter (where success))::int as used
         from login_attempt where ip_hmac = $1 and at > $2`,
      [hmac, since],
    );
    if (Math.max(0, rows[0]?.used ?? 0) >= p['auth.lockout_ip_failures']) {
      await client.query('COMMIT');
      return false;
    }
    await client.query(
      'insert into login_attempt (at, identifier_hmac, ip_hmac, success) values ($1, $2, $3, false)',
      [now, keyedHash(deps.hmacKey, 'id:field-phone-attempt'), hmac],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** A reserved attempt that turned out to be a correct sign-in is given back (a success row offsets one reservation). */
export async function releaseFieldAttempt(deps: LoginGuardDeps, ip: string | null): Promise<void> {
  await deps.pool.query(
    'insert into login_attempt (at, identifier_hmac, ip_hmac, success) values ($1, $2, $3, true)',
    [
      deps.clock.now(),
      keyedHash(deps.hmacKey, 'id:field-phone-attempt'),
      keyedHash(deps.hmacKey, `fieldip:${ip ?? 'unknown'}`),
    ],
  );
}

export async function recordLogin(
  deps: LoginGuardDeps,
  identifier: string,
  ip: string | null,
  success: boolean,
) {
  const { identifierHmac, ipHmac } = hashes(deps, identifier, ip);
  await deps.pool.query(
    'insert into login_attempt (at, identifier_hmac, ip_hmac, success) values ($1, $2, $3, $4)',
    [deps.clock.now(), identifierHmac, ipHmac, success],
  );
}

/** Hex keyed hash of an identifier, as stored in audit events (never the identifier itself). */
export function identifierHmacHex(hmacKey: string, identifier: string): string {
  return keyedHash(hmacKey, identifier).toString('hex');
}
