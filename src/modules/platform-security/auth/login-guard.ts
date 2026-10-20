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
