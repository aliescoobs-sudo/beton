// Helpers of scripts/import-excel.ts, kept apart so they can be tested: reading the arguments, the typed confirmation, and the
// second factor check. Not an entry point.
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createOTP } from '@better-auth/utils/otp';
import type pg from 'pg';
import type { Env } from '../src/lib/env.ts';
import { authSecretCipher } from '../src/modules/platform-security/auth/secret-cipher.ts';

export interface CliArgs {
  mode: 'dry-run' | 'apply' | 'rollback' | 'init-mapping' | null;
  /** The workbook (dry-run, apply), the run id (rollback) or the folder to write (init-mapping). */
  target: string | null;
  mapping: string | null;
  account: string | null;
  openingDate: string | null;
  problems: string[];
}

const FLAGS_WITH_VALUE = ['--mapping', '--account', '--opening-date'];
const MODES = {
  '--dry-run': 'dry-run',
  '--apply': 'apply',
  '--rollback': 'rollback',
  '--init-mapping': 'init-mapping',
} as const;

/** `--dry-run <file>`, `--apply <file>`, `--rollback <run id>`, `--init-mapping <folder>`; options `--mapping`, `--account`, `--opening-date`. */
export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    mode: null,
    target: null,
    mapping: null,
    account: null,
    openingDate: null,
    problems: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a in MODES) {
      const mode = MODES[a as keyof typeof MODES];
      if (out.mode && out.mode !== mode) out.problems.push(`${a} cannot be combined with --${out.mode}`);
      out.mode = mode;
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out.target = next;
        i++;
      } else out.problems.push(`${a} needs a value`);
    } else if (FLAGS_WITH_VALUE.includes(a)) {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out.problems.push(`${a} needs a value`);
      else {
        if (a === '--mapping') out.mapping = next;
        else if (a === '--account') out.account = next;
        else out.openingDate = next;
        i++;
      }
    } else if (a !== '--help' && a !== '-h') out.problems.push(`unknown argument ${a}`);
  }
  if (!out.mode && out.problems.length === 0)
    out.problems.push('choose --dry-run, --apply, --rollback or --init-mapping');
  if (out.openingDate && !/^\d{4}-\d{2}-\d{2}$/.test(out.openingDate))
    out.problems.push('--opening-date must be YYYY-MM-DD');
  if ((out.mode === 'apply' || out.mode === 'rollback') && !out.account)
    out.problems.push(`--${out.mode} needs --account <email> (the owner or app_admin who confirms)`);
  return out;
}

/** What the person must type before an apply: tied to this very file, so a confirmation cannot be reused for another one. */
export const confirmationPhrase = (sha256: string): string => `IMPORT ${sha256.slice(0, 12)}`;
export const rollbackPhrase = (runId: string): string => `ROLLBACK ${runId.slice(-12)}`;

export interface ImportAccount {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'app_admin';
}

/** The active owner or app_admin account with a verified authenticator, by email; null when there is none (the answer never says why). */
export async function findImportAccount(authPool: pg.Pool, email: string): Promise<ImportAccount | null> {
  const { rows } = await authPool.query<ImportAccount>(
    `select u.id, u.name, u.email, u.role from "user" u
      where lower(u.email) = lower($1) and u.status = 'active' and u.role in ('owner', 'app_admin') and u."twoFactorEnabled"
        and exists (select 1 from "twoFactor" t where t."userId" = u.id and t.verified)`,
    [email],
  );
  return rows[0] ?? null;
}

/** Checks a 6-digit code of the account's authenticator (the same secret the sign-in uses). */
export async function verifyTotp(
  authPool: pg.Pool,
  env: Pick<Env, 'AUTH_SECRET' | 'AUTH_SECRETS'>,
  userId: string,
  code: string,
): Promise<boolean> {
  if (!/^\d{6}$/.test(code.trim())) return false;
  const { rows } = await authPool.query<{ secret: string }>(
    `select secret from "twoFactor" where "userId" = $1 and verified limit 1`,
    [userId],
  );
  if (!rows[0]) return false;
  const secret = await authSecretCipher(env).decrypt(rows[0].secret);
  return createOTP(secret).verify(code.trim());
}

/**
 * R14-09: what the CLI says about an error it did not expect. Only a fixed code, and for a database error its SQLSTATE: never the
 * message, because a PostgreSQL message or detail can quote the row that failed (a name, an ICE, an amount).
 */
export function safeErrorLine(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code))
    return `DATABASE_ERROR ${code}: the database refused an operation; nothing more is shown here because its message can quote a row.`;
  if (typeof code === 'string' && /^[A-Z_]{3,30}$/.test(code)) return `SYSTEM_ERROR ${code}`;
  return 'UNEXPECTED_ERROR: the import stopped on an error that is not described here (no detail is printed: it could contain data of the file).';
}

/**
 * R14-09: a report file is created 0600 (owner only), exclusively, inside a 0700 folder that is not a link. Returns the path.
 * The folder's own mode is tightened: a report names sheets by position and rows by number, but it is still data about the company.
 */
export function writePrivateReport(dir: string, name: string, text: string, now: Date): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new Error('report folder refused: it is a link or not a folder');
  chmodSync(dir, 0o700);
  const file = path.join(dir, `import-${name}-${now.toISOString().replace(/[:.]/g, '-')}.txt`);
  writeFileSync(file, `${text}\n`, { mode: 0o600, flag: 'wx' });
  return file;
}
