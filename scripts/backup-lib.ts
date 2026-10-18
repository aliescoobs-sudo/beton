// Encrypted backups and restore tests (SPEC-platform-security §7, AC-SEC-12, CP2 audit anchor).
// Ops tooling, not app runtime: used by scripts/backup.ts and scripts/restore-test.ts.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { realClock } from '../src/modules/clock';
import { verifyAuditChain } from '../src/modules/platform-security/service/audit-chain';
import { MIGRATIONS_FOLDER } from './db-migrate';
import { RESTORE_TEST_DATABASE } from './db-bootstrap';

export interface AuditAnchor {
  createdAt: string;
  database: string;
  backupFile: string;
  backupSha256: string;
  /** Latest audit event when the backup started (null when the log is empty). */
  lastEventId: string | null;
  lastHash: string | null;
  counts: { audit_event: number };
}

export interface RestoreReport {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

/**
 * Connection settings for a libpq tool: the password goes through PGPASSWORD, never the command line. GSS encryption
 * is turned off: we never use Kerberos, and libpq's default attempt to negotiate it can hang on macOS.
 */
function libpq(url: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = '';
  return {
    args: ['--dbname', u.toString()],
    env: { ...process.env, PGPASSWORD: password, PGGSSENCMODE: 'disable' },
  };
}

function requireTool(bin: string, hint: string): void {
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) throw new Error(`${bin} is not available: ${hint}`);
}

function run(child: ReturnType<typeof spawn>, name: string): Promise<void> {
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr += d));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} failed (${code}): ${stderr.trim()}`)),
    );
  });
}

const sha256File = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** pg_dump (as the read-only backup role) piped into age; then the audit anchor written next to it. */
export async function createBackup(options: {
  /** belgobeton_backup: read-only, BYPASSRLS, so the dump contains every row. */
  backupUrl: string;
  recipient: string;
  dir: string;
  ageBin?: string;
}): Promise<{ backupFile: string; anchorFile: string; anchor: AuditAnchor }> {
  const age = options.ageBin ?? 'age';
  requireTool(age, 'install age (macOS: brew install age; Debian/Ubuntu: apt install age)');
  requireTool('pg_dump', 'install the PostgreSQL client tools (pg_dump, psql)');

  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  const stamp = realClock.now().toISOString().replace(/[:.]/g, '-');
  const backupFile = join(options.dir, `${stamp}.sql.age`);
  const anchorFile = join(options.dir, `${stamp}.audit-anchor.json`);
  const database = new URL(options.backupUrl).pathname.slice(1);

  // Anchor first: every event up to it is in the dump; later ones may be too.
  const pool = new pg.Pool({ connectionString: options.backupUrl, max: 1 });
  let last: { id: string; hash: string } | undefined;
  let count = 0;
  try {
    const latest = await pool.query<{ id: string; hash: string }>(
      `select id::text, encode(hash, 'hex') as hash from audit_event order by id desc limit 1`,
    );
    last = latest.rows[0];
    const counted = await pool.query<{ n: number }>(`select count(*)::int as n from audit_event`);
    count = counted.rows[0]?.n ?? 0;
  } finally {
    await pool.end();
  }

  const conn = libpq(options.backupUrl);
  const dump = spawn('pg_dump', [...conn.args, '--format=plain', '--quote-all-identifiers'], {
    env: conn.env,
  });
  const seal = spawn(age, ['-r', options.recipient, '-o', backupFile], { stdio: ['pipe', 'ignore', 'pipe'] });
  dump.stdout.pipe(seal.stdin);
  await Promise.all([run(dump, 'pg_dump'), run(seal, 'age')]);

  const anchor: AuditAnchor = {
    createdAt: realClock.now().toISOString(),
    database,
    backupFile: backupFile.split('/').pop()!,
    backupSha256: sha256File(backupFile),
    lastEventId: last?.id ?? null,
    lastHash: last?.hash ?? null,
    counts: { audit_event: count },
  };
  writeFileSync(anchorFile, `${JSON.stringify(anchor, null, 2)}\n`, { mode: 0o600 });
  chmodSync(backupFile, 0o600); // owner-only, like the anchor
  return { backupFile, anchorFile, anchor };
}

/**
 * Decrypts a backup into a scratch database and checks it: file integrity against the anchor, migrations, row
 * counts, the audit hash chain, and the anchored event's hash (catches a full chain rewrite). Drops the scratch DB.
 */
export async function restoreCheck(options: {
  backupFile: string;
  anchorFile: string;
  identityFile: string;
  /** Superuser URL to the maintenance database (`postgres`). */
  adminUrl: string;
  ageBin?: string;
}): Promise<RestoreReport> {
  const age = options.ageBin ?? 'age';
  requireTool(age, 'install age (macOS: brew install age; Debian/Ubuntu: apt install age)');
  requireTool('psql', 'install the PostgreSQL client tools (pg_dump, psql)');

  const anchor = JSON.parse(readFileSync(options.anchorFile, 'utf8')) as AuditAnchor;
  const checks: RestoreReport['checks'] = [];
  const done = () => ({ ok: checks.every((c) => c.ok), checks });

  const integrity = sha256File(options.backupFile) === anchor.backupSha256;
  checks.push({ name: 'backup file matches its anchor', ok: integrity });
  if (!integrity) return done();

  const admin = new pg.Client({ connectionString: options.adminUrl });
  await admin.connect();
  const scratchUrl = new URL(options.adminUrl);
  scratchUrl.pathname = `/${RESTORE_TEST_DATABASE}`;
  try {
    await admin.query(`drop database if exists "${RESTORE_TEST_DATABASE}" with (force)`);
    await admin.query(`create database "${RESTORE_TEST_DATABASE}" owner belgobeton_migrator`);

    try {
      const conn = libpq(scratchUrl.toString());
      const open = spawn(age, ['-d', '-i', options.identityFile], { stdio: ['pipe', 'pipe', 'pipe'] });
      const load = spawn('psql', [...conn.args, '-v', 'ON_ERROR_STOP=1', '--quiet'], {
        env: conn.env,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      createReadStream(options.backupFile).pipe(open.stdin!);
      open.stdout!.pipe(load.stdin!);
      await Promise.all([run(open, 'age -d'), run(load, 'psql')]);
      checks.push({ name: 'decrypt and restore', ok: true });
    } catch (error) {
      checks.push({ name: 'decrypt and restore', ok: false, detail: (error as Error).message });
      return done();
    }

    const db = new pg.Client({ connectionString: scratchUrl.toString() });
    await db.connect();
    try {
      const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8'));
      const {
        rows: [m],
      } = await db.query(`select count(*)::int as n from drizzle.__drizzle_migrations`);
      checks.push({
        name: 'migrations',
        ok: m.n === journal.entries.length,
        detail: `${m.n}/${journal.entries.length}`,
      });

      const {
        rows: [c],
      } = await db.query(`select count(*)::int as n from audit_event`);
      checks.push({
        name: 'audit_event row count',
        ok: c.n >= anchor.counts.audit_event,
        detail: `${c.n} ≥ ${anchor.counts.audit_event}`,
      });

      const chain = await verifyAuditChain(db);
      checks.push({
        name: 'audit chain',
        ok: chain.ok,
        detail: chain.ok ? `${chain.checked} events` : `broken at ${chain.brokenId}`,
      });

      let anchored = anchor.lastEventId === null;
      if (anchor.lastEventId !== null) {
        const { rows } = await db.query(`select encode(hash, 'hex') as hash from audit_event where id = $1`, [
          anchor.lastEventId,
        ]);
        anchored = rows[0]?.hash === anchor.lastHash;
      }
      checks.push({
        name: 'anchored event hash',
        ok: anchored,
        detail: `event ${anchor.lastEventId ?? '(none)'}`,
      });
    } finally {
      await db.end();
    }
    return done();
  } finally {
    await admin.query(`drop database if exists "${RESTORE_TEST_DATABASE}" with (force)`);
    await admin.end();
  }
}
