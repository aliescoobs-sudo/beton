// Helpers of scripts/import-excel.ts, kept apart so they can be tested: reading the arguments, the typed confirmation, and the
// second factor check. Not an entry point.
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createOTP } from '@better-auth/utils/otp';
import type pg from 'pg';
import type { Env } from '../src/lib/env.ts';
import { realClock } from '../src/modules/clock/index.ts';
import { keyedHash } from '../src/lib/crypto/hmac.ts';
import { readParameters } from '../src/modules/platform-security/index.ts';
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

export {
  importConfirmation,
  rollbackConfirmation,
  stableJson,
} from '../src/modules/importer/domain/confirmation.ts';

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

export type CodeVerdict = 'ok' | 'wrong' | 'locked' | 'ineligible';
const TOTP_PERIOD_SECONDS = 30;

/**
 * R14-11: the second factor of the import commands, with the SAME protections as the application's own step-up:
 *   - the time-step the code belongs to (the same +-1 window) is CLAIMED atomically in `totp_used_step`: a code already used anywhere (a
 *     sign-in, another import, a rollback) or an earlier step is refused, so one code cannot be replayed for several operations;
 *   - the failure budget is PERSISTED in `login_attempt` (keyed hashes only), so restarting the command does not reset the guesses: after
 *     `auth.lockout_account_failures` failures inside `auth.lockout_window_minutes` the account answers 'locked' (attempts made while
 *     locked are not counted) until a success or the window passes;
 *   - the account's eligibility (active, owner or app_admin, authenticator enabled and verified) is re-checked at the moment of use;
 *   - everything runs in one transaction under a per-account advisory lock, so parallel attempts are counted one after the other.
 * The caller binds the verified code to its operation (the importer refuses an apply whose proof names another operation).
 */
export async function verifyImportCode(
  authPool: pg.Pool,
  env: Pick<Env, 'AUTH_SECRET' | 'AUTH_SECRETS' | 'LOOKUP_HMAC_KEY'>,
  input: { userId: string; code: string; now?: Date },
): Promise<CodeVerdict> {
  const now = input.now ?? realClock.now();
  const params = await readParameters(authPool);
  const id = keyedHash(env.LOOKUP_HMAC_KEY, `id:import-cli:${input.userId}`);
  const ip = keyedHash(env.LOOKUP_HMAC_KEY, 'ip:import-cli');
  const client = await authPool.connect();
  let destroyed = false;
  try {
    await client.query('BEGIN');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `import-totp:${input.userId}`,
    ]);
    const eligible = await client.query(
      `select 1 from "user" u
        where u.id = $1 and u.status = 'active' and u.role in ('owner', 'app_admin') and u."twoFactorEnabled"
          and exists (select 1 from "twoFactor" t where t."userId" = u.id and t.verified)`,
      [input.userId],
    );
    if (!eligible.rowCount) {
      await client.query('ROLLBACK');
      return 'ineligible';
    }
    const since = new Date(now.getTime() - params['auth.lockout_window_minutes'] * 60_000);
    const failures = await client.query<{ n: number }>(
      `select count(*)::int as n from login_attempt a
        where a.identifier_hmac = $1 and not a.success and a.at > $2
          and a.at > coalesce((select max(s.at) from login_attempt s where s.identifier_hmac = $1 and s.success), '-infinity')`,
      [id, since],
    );
    if ((failures.rows[0]?.n ?? 0) >= params['auth.lockout_account_failures']) {
      await client.query('COMMIT');
      return 'locked';
    }
    const record = (success: boolean) =>
      client.query(
        'insert into login_attempt (at, identifier_hmac, ip_hmac, success) values ($1, $2, $3, $4)',
        [now, id, ip, success],
      );
    const code = input.code.trim();
    const sealed = /^\d{6}$/.test(code)
      ? (
          await client.query<{ secret: string }>(
            `select secret from "twoFactor" where "userId" = $1 and verified limit 1`,
            [input.userId],
          )
        ).rows[0]?.secret
      : undefined;
    let step: number | undefined;
    if (sealed) {
      const otp = createOTP(await authSecretCipher(env).decrypt(sealed));
      const current = Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
      for (const candidate of [current - 1, current, current + 1])
        if ((await otp.hotp(candidate)) === code) step = candidate;
    }
    if (step === undefined) {
      await record(false);
      await client.query('COMMIT');
      return 'wrong';
    }
    const claimed = await client.query(
      `insert into totp_used_step (user_id, last_step) values ($1, $2)
       on conflict (user_id) do update set last_step = excluded.last_step where totp_used_step.last_step < excluded.last_step`,
      [input.userId, step],
    );
    if (!claimed.rowCount) {
      await record(false); // a replayed or earlier code counts as a failure
      await client.query('COMMIT');
      return 'wrong';
    }
    await record(true);
    await client.query('COMMIT');
    return 'ok';
  } catch (error) {
    // a transaction that cannot be ended cleanly takes its connection with it (R14-03)
    const ended = await client.query('ROLLBACK').then(
      () => true,
      () => false,
    );
    if (!ended) {
      destroyed = true;
      client.release(true);
    }
    throw error;
  } finally {
    if (!destroyed) client.release();
  }
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
