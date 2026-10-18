import type pg from 'pg';
import { keyedHash } from '@/lib/crypto/hmac';
import type { Clock } from '@/modules/clock';

// SPEC-platform-security §5. Become parameters in T19.
export const ACCOUNT_MAX_FAILURES = 5;
export const IP_MAX_FAILURES = 20;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export interface LoginGuardDeps {
  pool: pg.Pool; // belgobeton_auth
  hmacKey: string;
  clock: Clock;
}

export type LoginVerdict = 'allowed' | 'account_locked' | 'ip_locked';

/** Login identifiers are emails; compared case- and space-insensitively. */
export function normalizeIdentifier(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * Client IP from the reverse proxy's X-Forwarded-For (first hop). Null when unknown: the per-IP limit is then
 * skipped rather than applied to everyone at once; the per-account limit always applies.
 */
export function clientIp(headers: Headers | undefined): string | null {
  return headers?.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
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
  const since = new Date(deps.clock.now().getTime() - LOCKOUT_WINDOW_MS);
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
  if (account_failures >= ACCOUNT_MAX_FAILURES) return 'account_locked';
  if (ip !== null && ip_failures >= IP_MAX_FAILURES) return 'ip_locked';
  return 'allowed';
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
