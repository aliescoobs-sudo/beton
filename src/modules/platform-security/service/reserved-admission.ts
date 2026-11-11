import type pg from 'pg';

/**
 * T10a (R17-03): the admission check. The server (and the seed and the migrations) refuse to run while any account with a reserved role
 * (`partner`, `support`) is usable (status active). The database revokes their sessions (migration 0212, `admit_no_reserved_accounts`) and
 * refuses a new session, a creation or a re-activation from the application's logins; this is the second line, in the process.
 */
export class ReservedAccountsError extends Error {
  readonly count: number;
  constructor(count: number) {
    super(
      `admission: ${count} usable account(s) hold a reserved role (partner or support); disable them or give them a V1 role before this version starts`,
    );
    this.count = count;
    this.name = 'ReservedAccountsError';
  }
}

/** 42883 undefined function, 3F000 invalid schema name: the admission objects are not in this database. */
const missingObject = (error: unknown): boolean =>
  ['42883', '3F000'].includes((error as { code?: string }).code ?? '');

/** The admission function is missing: this database has not been through migration 0212/0220, so nothing can be said about its reserved accounts. */
export class AdmissionUnavailableError extends Error {
  constructor() {
    super(
      'admission: the reserved-account admission functions are missing from this database (migrations 0212 and 0220 are not applied); the server does not start',
    );
    this.name = 'AdmissionUnavailableError';
  }
}

/**
 * The number of usable reserved-role accounts. R18-03: a database WITHOUT the function does not answer "zero", it FAILS (before, the missing
 * function counted as no reserved account, so an old schema was admitted). Applying the migrations is the way out.
 */
export async function usableReservedAccounts(pool: pg.Pool): Promise<number> {
  try {
    const { rows } = await pool.query<{ n: string }>('select public.usable_reserved_role_accounts() as n');
    return Number(rows[0]?.n ?? 0);
  } catch (error) {
    if (missingObject(error)) throw new AdmissionUnavailableError();
    throw error;
  }
}

/**
 * Revokes every session of a reserved-role account, as its OWN statement (autocommit): the deletion is committed before any refusal, so a
 * failed admission cannot roll it back and leave an old cookie alive (R18-03).
 */
export async function revokeReservedSessions(pool: pg.Pool): Promise<number> {
  try {
    const { rows } = await pool.query<{ n: string }>('select public.revoke_reserved_sessions() as n');
    return Number(rows[0]?.n ?? 0);
  } catch (error) {
    if (missingObject(error)) throw new AdmissionUnavailableError();
    throw error;
  }
}

/** Revoke first (committed), then count; a usable reserved-role account stops the caller. */
export async function assertNoUsableReservedAccounts(pool: pg.Pool): Promise<void> {
  await revokeReservedSessions(pool);
  const n = await usableReservedAccounts(pool);
  if (n > 0) throw new ReservedAccountsError(n);
}

/**
 * The server (not the seed, not a test database that deliberately runs the policy tests of the reserved roles) also needs the database boundary
 * switched on: ctx.actor_role() refuses a stored reserved role. An off switch is a test database; a server never starts on it.
 */
export async function assertReservedBoundaryOn(pool: pg.Pool): Promise<void> {
  try {
    const { rows } = await pool.query<{ on: boolean }>('select ctx.reserved_boundary_on() as "on"');
    if (rows[0]?.on !== true)
      throw new Error(
        'admission: the reserved-role boundary of the database is switched off; the server does not start',
      );
  } catch (error) {
    if (missingObject(error)) throw new AdmissionUnavailableError();
    throw error;
  }
}
