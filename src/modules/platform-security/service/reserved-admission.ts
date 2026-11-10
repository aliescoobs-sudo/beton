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

export async function usableReservedAccounts(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('select public.usable_reserved_role_accounts() as n');
  return Number(rows[0]?.n ?? 0);
}

export async function assertNoUsableReservedAccounts(pool: pg.Pool): Promise<void> {
  const n = await usableReservedAccounts(pool);
  if (n > 0) throw new ReservedAccountsError(n);
}
