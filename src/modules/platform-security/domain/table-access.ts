import type { DB_ROLES } from '@/lib/db/rls-context';

type DbRole = (typeof DB_ROLES)[number];
export type ReadScope = 'all' | 'own' | 'none';

interface RlsTable {
  kind: 'rls';
  /** Rows each request role may read (SPEC §4). */
  read: Record<DbRole, ReadScope>;
  /** FORCE ROW LEVEL SECURITY (also applies to the owner). false only with a documented reason. */
  force: boolean;
  /** Captured by audit.capture(). false only with a documented reason. */
  audited: boolean;
  exception?: string;
}

interface AuthOnlyTable {
  kind: 'auth_only';
  /** Readable only by belgobeton_auth; belgobeton_app has no privilege at all. */
  reason: string;
}

/**
 * Every table in the public schema, with its access rule. The meta-test (tests/rls/meta.int.test.ts) fails for a
 * table missing here or not matching its rule; the matrix test reads `read` to check RLS for every role.
 * Later modules add their business tables as `{ kind: 'rls', force: true, audited: true, read: … }`.
 */
export const TABLE_ACCESS = {
  audit_event: {
    kind: 'rls',
    read: { owner: 'all', partner: 'all', office: 'own', plant: 'own', system: 'none', anonymous: 'none' },
    force: false,
    audited: false,
    exception:
      'CP2: its SECURITY DEFINER writers run as the owner and must read the latest hash, so RLS is enabled, not ' +
      'forced; it is the audit log itself, so it is not captured by the audit trigger.',
  },
  parameter: {
    kind: 'rls',
    read: { owner: 'all', partner: 'all', office: 'none', plant: 'none', system: 'all', anonymous: 'none' },
    force: true,
    audited: true,
    exception:
      'Also readable by belgobeton_auth (login lockout runs before any session); writes: owner only.',
  },
  security_checklist_item: {
    kind: 'rls',
    read: { owner: 'all', partner: 'all', office: 'none', plant: 'none', system: 'all', anonymous: 'none' },
    force: true,
    audited: true,
    exception: 'Also readable by belgobeton_system (banner, REAL_DATA boot guard); writes: owner only.',
  },
  security_check_run: {
    kind: 'rls',
    read: { owner: 'all', partner: 'all', office: 'none', plant: 'none', system: 'all', anonymous: 'none' },
    force: true,
    audited: true,
    exception: 'Append-only automated evidence, inserted by belgobeton_system with the system actor only.',
  },
  security_alert: {
    kind: 'rls',
    read: { owner: 'all', partner: 'all', office: 'none', plant: 'none', system: 'all', anonymous: 'none' },
    force: true,
    audited: true,
    exception: 'Inserted by belgobeton_system with the system actor (break-glass CLI).',
  },
  security_alert_ack: {
    kind: 'rls',
    read: { owner: 'own', partner: 'own', office: 'none', plant: 'none', system: 'none', anonymous: 'none' },
    force: true,
    audited: true,
  },
  sim_clock: {
    kind: 'rls',
    read: { owner: 'all', partner: 'all', office: 'all', plant: 'all', system: 'all', anonymous: 'none' },
    force: true,
    audited: true,
    exception:
      'Singleton, SPEC-clock §3. Every signed-in role reads it (badge, clock.now()); also readable by ' +
      'belgobeton_auth (pre-session pages) and the owner via the ctx.sim_now() definer; updates: owner or system.',
  },
  scheduled_job_run: {
    kind: 'rls',
    read: { owner: 'all', partner: 'all', office: 'none', plant: 'none', system: 'all', anonymous: 'none' },
    force: true,
    audited: true,
    exception: 'SPEC-clock §3 idempotency ledger; written only by the system actor (job runner).',
  },
  user: { kind: 'auth_only', reason: 'Better Auth account table (ADR 0001)' },
  session: { kind: 'auth_only', reason: 'Better Auth sessions (ADR 0001)' },
  account: { kind: 'auth_only', reason: 'Better Auth credentials: password hashes (ADR 0001)' },
  verification: { kind: 'auth_only', reason: 'Better Auth pending verifications (ADR 0001)' },
  twoFactor: { kind: 'auth_only', reason: 'TOTP secrets and encrypted recovery codes (ADR 0001)' },
  login_attempt: { kind: 'auth_only', reason: 'Login lockout counters, keyed hashes only' },
  totp_used_step: { kind: 'auth_only', reason: 'TOTP replay protection' },
  two_factor_pending: {
    kind: 'auth_only',
    reason: 'Staged re-enrolment (DECISIONS 77): encrypted secret and codes',
  },
} as const satisfies Record<string, RlsTable | AuthOnlyTable>;

export type TableName = keyof typeof TABLE_ACCESS;

export const RLS_TABLES = (Object.keys(TABLE_ACCESS) as TableName[]).filter(
  (
    t,
  ): t is Extract<
    TableName,
    { [K in TableName]: (typeof TABLE_ACCESS)[K]['kind'] extends 'rls' ? K : never }[TableName]
  > => TABLE_ACCESS[t].kind === 'rls',
);
