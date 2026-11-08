// Encrypted backups and restore tests (SPEC-platform-security §7, AC-SEC-12; C2 / CODEX-REVIEW-R9 items 1, 8, 9).
// Ops tooling, not app runtime: used by scripts/backup.ts, scripts/restore-test.ts and scripts/backup-verify.ts.
//
// One backup is ONE SET under one timestamp:
//   <stamp>.sql.age            the database (pg_dump, sealed with the age public key)
//   <stamp>.files.tar.age      the stored documents (BL scans, supplier invoice photos), sealed the same way
//   <stamp>.audit-anchor.json  the manifest: both artifacts with sha256 and size, the file count, the audit anchor.
//                              Written LAST and atomically, so a set without a manifest is incomplete and is never pulled.
// The server cannot sign for the office: the office machine that pulls the set verifies it and signs a RECEIPT (ed25519, key held
// off the server). Every restore checks that signature, so a set rewritten on a compromised server after the pull is detected.
// The age key alone does not open the documents or the encrypted fields: restore also needs FIELD_ENCRYPTION_KEYS from the escrow.
import { spawn, spawnSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { createDiskStore } from '../src/lib/files/store';
import { realClock } from '../src/modules/clock';
import { verifyAuditChain } from '../src/modules/platform-security/service/audit-chain';
import { MIGRATIONS_FOLDER } from './db-migrate';
import { RESTORE_TEST_DATABASE } from './db-bootstrap';

export interface BackupArtifact {
  file: string;
  sha256: string;
  bytes: number;
}

/** The manifest (file name kept: `.audit-anchor.json`). */
export interface AuditAnchor {
  schema: 2;
  createdAt: string;
  database: string;
  artifacts: { database: BackupArtifact; files: BackupArtifact };
  /** Stored documents in the archive. */
  fileCount: number;
  /** Latest audit event when the backup started (null when the log is empty). */
  lastEventId: string | null;
  lastHash: string | null;
  counts: { audit_event: number };
}

export interface RestoreReport {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

export const MANIFEST_SUFFIX = '.audit-anchor.json';
export const RECEIPT_SUFFIX = '.pull-receipt.json';
export const RECEIPT_SIG_SUFFIX = '.pull-receipt.sig';

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

/** Streams the file: a backup can be larger than the memory of the host. */
export async function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

const hashOf = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** The stored documents of a directory: `<2 hex>/<uuid>.bin`. The directory must exist: a missing one is an error, never "no files". */
export function countStoreFiles(dir: string): number {
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new Error(`The file store directory does not exist: ${dir}. Set FILE_STORE_DIR to the real store.`);
  let n = 0;
  for (const shard of readdirSync(dir, { withFileTypes: true }))
    if (shard.isDirectory()) n += readdirSync(join(dir, shard.name)).filter((f) => f.endsWith('.bin')).length;
  return n;
}

/** Writes `bytes` to `<file>.partial` then renames: a reader never sees a half-written file. */
function writeAtomic(file: string, bytes: string, mode: number): void {
  writeFileSync(`${file}.partial`, bytes, { mode });
  renameSync(`${file}.partial`, file);
}

/** Dump + stored documents, each sealed with age, then the manifest (last). */
export async function createBackup(options: {
  /** belgobeton_backup: read-only, BYPASSRLS, so the dump contains every row. */
  backupUrl: string;
  recipient: string;
  dir: string;
  /** The real file store (a missing directory fails the backup). */
  fileStoreDir: string;
  ageBin?: string;
}): Promise<{ manifestFile: string; manifest: AuditAnchor; files: string[] }> {
  const age = options.ageBin ?? 'age';
  requireTool(age, 'install age (macOS: brew install age; Debian/Ubuntu: apt install age)');
  requireTool('pg_dump', 'install the PostgreSQL client tools (pg_dump, psql)');
  requireTool('tar', 'tar is required to archive the stored documents');
  const fileCountBefore = countStoreFiles(options.fileStoreDir); // fails early on a wrong path

  // 0750 with the group of the directory (setgid, see scripts/ops/init-host.sh): the pull account can read, never write.
  mkdirSync(options.dir, { recursive: true, mode: 0o750 });
  const stamp = realClock.now().toISOString().replace(/[:.]/g, '-');
  const dbFile = join(options.dir, `${stamp}.sql.age`);
  const filesFile = join(options.dir, `${stamp}.files.tar.age`);
  const manifestFile = join(options.dir, `${stamp}${MANIFEST_SUFFIX}`);
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

  const partials: string[] = [];
  try {
    // Database first, documents second: a file is written before the row that points to it, so the archive holds a file for every
    // row of the dump (it may hold a few more).
    const conn = libpq(options.backupUrl);
    const dump = spawn('pg_dump', [...conn.args, '--format=plain', '--quote-all-identifiers'], {
      env: conn.env,
    });
    partials.push(`${dbFile}.partial`);
    const sealDb = spawn(age, ['-r', options.recipient, '-o', `${dbFile}.partial`], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    dump.stdout.pipe(sealDb.stdin);
    await Promise.all([run(dump, 'pg_dump'), run(sealDb, 'age (database)')]);
    renameSync(`${dbFile}.partial`, dbFile);

    const tar = spawn('tar', ['-C', options.fileStoreDir, '-cf', '-', '.'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    partials.push(`${filesFile}.partial`);
    const sealFiles = spawn(age, ['-r', options.recipient, '-o', `${filesFile}.partial`], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    tar.stdout.pipe(sealFiles.stdin);
    await Promise.all([run(tar, 'tar (documents)'), run(sealFiles, 'age (documents)')]);
    renameSync(`${filesFile}.partial`, filesFile);
  } catch (error) {
    for (const f of [...partials, dbFile, filesFile]) rmSync(f, { force: true });
    throw error;
  }

  for (const f of [dbFile, filesFile]) chmodSync(f, 0o640);
  const manifest: AuditAnchor = {
    schema: 2,
    createdAt: realClock.now().toISOString(),
    database,
    artifacts: {
      database: { file: dbFile.split('/').pop()!, ...(await sha256File(dbFile)) },
      files: { file: filesFile.split('/').pop()!, ...(await sha256File(filesFile)) },
    },
    fileCount: Math.max(fileCountBefore, countStoreFiles(options.fileStoreDir)),
    lastEventId: last?.id ?? null,
    lastHash: last?.hash ?? null,
    counts: { audit_event: count },
  };
  writeAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 0o640);
  return { manifestFile, manifest, files: [dbFile, filesFile, manifestFile] };
}

export function readManifest(file: string): AuditAnchor {
  const m = JSON.parse(readFileSync(file, 'utf8')) as Partial<AuditAnchor>;
  if (m.schema !== 2 || !m.artifacts?.database || !m.artifacts.files)
    throw new Error(
      'This is an old backup manifest without the stored documents: it cannot be restored as a complete backup.',
    );
  return m as AuditAnchor;
}

/** Complete and intact (artifacts present, size and sha256 as in the manifest), optionally fresh. */
export async function verifySet(
  manifestFile: string,
  options: { maxAgeMs?: number; now?: Date } = {},
): Promise<{ ok: boolean; problems: string[]; manifest?: AuditAnchor }> {
  const problems: string[] = [];
  let manifest: AuditAnchor;
  try {
    manifest = readManifest(manifestFile);
  } catch (error) {
    return { ok: false, problems: [(error as Error).message] };
  }
  const dir = join(manifestFile, '..');
  for (const [kind, art] of Object.entries(manifest.artifacts)) {
    const file = join(dir, art.file);
    if (!existsSync(file)) {
      problems.push(`${kind} archive missing: ${art.file}`);
      continue;
    }
    const got = await sha256File(file);
    if (got.bytes !== art.bytes || got.sha256 !== art.sha256)
      problems.push(`${kind} archive does not match the manifest`);
    if (got.bytes === 0) problems.push(`${kind} archive is empty`);
  }
  if (options.maxAgeMs !== undefined) {
    const age = (options.now ?? realClock.now()).getTime() - Date.parse(manifest.createdAt);
    if (!(age <= options.maxAgeMs)) problems.push(`set is ${Math.round(age / 3_600_000)} h old (too old)`);
  }
  return { ok: problems.length === 0, problems, manifest };
}

// ---- independent signature (ed25519, key held off the server) --------------------------------------------------------------

export function generateSigningKeys(dir: string): { privateKeyFile: string; publicKeyFile: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyFile = join(dir, 'backup-signing.key');
  const publicKeyFile = join(dir, 'backup-signing.pub');
  writeFileSync(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
    flag: 'wx',
  });
  writeFileSync(publicKeyFile, publicKey.export({ type: 'spki', format: 'pem' }), {
    mode: 0o644,
    flag: 'wx',
  });
  return { privateKeyFile, publicKeyFile };
}

export interface PullReceipt {
  schema: 1;
  manifestFile: string;
  manifestSha256: string;
  databaseSha256: string;
  filesSha256: string;
  manifestCreatedAt: string;
  auditEvents: number;
  pulledAt: string;
}

/** Office machine only: records what was pulled and verified, signed with the key that never leaves it. */
export async function signReceipt(
  manifestFile: string,
  privateKeyFile: string,
  now = realClock.now(),
): Promise<PullReceipt> {
  const checked = await verifySet(manifestFile);
  if (!checked.ok || !checked.manifest)
    throw new Error(`Refusing to sign a set that does not verify: ${checked.problems.join('; ')}`);
  const m = checked.manifest;
  const receipt: PullReceipt = {
    schema: 1,
    manifestFile: manifestFile.split('/').pop()!,
    manifestSha256: hashOf(readFileSync(manifestFile)),
    databaseSha256: m.artifacts.database.sha256,
    filesSha256: m.artifacts.files.sha256,
    manifestCreatedAt: m.createdAt,
    auditEvents: m.counts.audit_event,
    pulledAt: now.toISOString(),
  };
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  const signature = edSign(null, Buffer.from(body), createPrivateKey(readFileSync(privateKeyFile)));
  const base = manifestFile.slice(0, -MANIFEST_SUFFIX.length);
  writeFileSync(`${base}${RECEIPT_SUFFIX}`, body, { mode: 0o600 });
  writeFileSync(`${base}${RECEIPT_SIG_SUFFIX}`, signature.toString('base64'), { mode: 0o600 });
  return receipt;
}

export function readReceipt(
  manifestFile: string,
): { receipt: PullReceipt; body: Buffer; signature: Buffer } | null {
  const base = manifestFile.slice(0, -MANIFEST_SUFFIX.length);
  if (!existsSync(`${base}${RECEIPT_SUFFIX}`) || !existsSync(`${base}${RECEIPT_SIG_SUFFIX}`)) return null;
  const body = readFileSync(`${base}${RECEIPT_SUFFIX}`);
  return {
    receipt: JSON.parse(body.toString('utf8')) as PullReceipt,
    body,
    signature: Buffer.from(readFileSync(`${base}${RECEIPT_SIG_SUFFIX}`, 'utf8').trim(), 'base64'),
  };
}

/** Signature valid for the public key AND the receipt still describes the files on disk. */
export function verifyReceipt(manifestFile: string, publicKeyFile: string): { ok: boolean; detail: string } {
  const found = readReceipt(manifestFile);
  if (!found) return { ok: false, detail: 'no signed pull receipt for this set' };
  const valid = edVerify(null, found.body, createPublicKey(readFileSync(publicKeyFile)), found.signature);
  if (!valid) return { ok: false, detail: 'receipt signature is invalid' };
  const m = readManifest(manifestFile);
  const r = found.receipt;
  const same =
    r.manifestSha256 === hashOf(readFileSync(manifestFile)) &&
    r.databaseSha256 === m.artifacts.database.sha256 &&
    r.filesSha256 === m.artifacts.files.sha256;
  return same
    ? { ok: true, detail: `signed ${r.pulledAt}` }
    : { ok: false, detail: 'the set differs from what the office signed (rewritten after the pull?)' };
}

/** Signs any small JSON document (the restore report) with the office key. */
export function signText(text: string, privateKeyFile: string): string {
  return edSign(null, Buffer.from(text), createPrivateKey(readFileSync(privateKeyFile))).toString('base64');
}
export function verifyText(text: string, signatureB64: string, publicKeyFile: string): boolean {
  return edVerify(
    null,
    Buffer.from(text),
    createPublicKey(readFileSync(publicKeyFile)),
    Buffer.from(signatureB64.trim(), 'base64'),
  );
}

/**
 * Pull step: verifies every staged set, compares it with what the office signed before, copies the good ones into the store,
 * signs a receipt for each new one, prunes. Returns problems instead of throwing so the caller can alert with the full list.
 */
export async function ingestSets(options: {
  staging: string;
  store: string;
  privateKeyFile: string;
  maxAgeMs: number;
  keep: number;
  now?: Date;
}): Promise<{ ok: boolean; problems: string[]; newest: string | null; added: string[] }> {
  const now = options.now ?? realClock.now();
  mkdirSync(options.store, { recursive: true, mode: 0o700 });
  const problems: string[] = [];
  const added: string[] = [];
  const manifests = readdirSync(options.staging)
    .filter((f) => f.endsWith(MANIFEST_SUFFIX))
    .sort();
  let newest: string | null = null;
  let newestCreated = '';
  for (const name of manifests) {
    const staged = join(options.staging, name);
    const base = name.slice(0, -MANIFEST_SUFFIX.length);
    const checked = await verifySet(staged);
    if (!checked.ok || !checked.manifest) {
      problems.push(`${base}: ${checked.problems.join('; ')}`);
      continue;
    }
    const local = join(options.store, name);
    const known = existsSync(local) ? readReceipt(local) : null;
    if (known && known.receipt.manifestSha256 !== hashOf(readFileSync(staged))) {
      problems.push(
        `${base}: the server copy differs from the set the office signed earlier (tampered or rewritten)`,
      );
      continue;
    }
    const m = checked.manifest;
    const have = existsSync(local) ? (await verifySet(local)).ok : false;
    if (!have) {
      for (const f of [m.artifacts.database.file, m.artifacts.files.file, name]) {
        // artifacts first, manifest last, each atomically
        copyAtomic(join(options.staging, f), join(options.store, f));
      }
      await signReceipt(local, options.privateKeyFile, now);
      added.push(base);
    }
    if (m.createdAt > newestCreated) {
      newestCreated = m.createdAt;
      newest = base;
    }
  }
  if (!newest) problems.push('no complete backup set arrived');
  else if (now.getTime() - Date.parse(newestCreated) > options.maxAgeMs)
    problems.push(`the newest set (${newest}) is older than ${Math.round(options.maxAgeMs / 3_600_000)} h`);

  // continuity: the audit log of the newest set may not be shorter than the one the office signed last
  const receipts = readdirSync(options.store)
    .filter((f) => f.endsWith(RECEIPT_SUFFIX))
    .sort();
  const events = receipts.map(
    (f) => (JSON.parse(readFileSync(join(options.store, f), 'utf8')) as PullReceipt).auditEvents,
  );
  for (let i = 1; i < events.length; i++)
    if ((events[i] as number) < (events[i - 1] as number))
      problems.push(`audit log of ${receipts[i]} is shorter than the previous set (rollback or rewrite)`);

  // prune the oldest beyond `keep` sets
  const sets = readdirSync(options.store)
    .filter((f) => f.endsWith(MANIFEST_SUFFIX))
    .sort();
  for (const name of sets.slice(0, Math.max(0, sets.length - options.keep))) {
    const base = name.slice(0, -MANIFEST_SUFFIX.length);
    for (const suffix of ['.sql.age', '.files.tar.age', MANIFEST_SUFFIX, RECEIPT_SUFFIX, RECEIPT_SIG_SUFFIX])
      rmSync(join(options.store, `${base}${suffix}`), { force: true });
  }
  return { ok: problems.length === 0, problems, newest, added };
}

function copyAtomic(from: string, to: string): void {
  const temp = `${to}.incoming`;
  const bytes = readFileSync(from);
  writeFileSync(temp, bytes, { mode: 0o600 });
  renameSync(temp, to);
}

// ---- restore -------------------------------------------------------------------------------------------------------------------

/**
 * Decrypts a set into a scratch database and a scratch directory and checks it: the office's signature, file integrity against the
 * manifest, migrations, row counts, the audit hash chain, the anchored event's hash, and that every stored document opens with the
 * escrowed keys. Drops the scratch database.
 */
export async function restoreCheck(options: {
  manifestFile: string;
  identityFile: string;
  /** Public key of the office signing key. Required unless allowUnsigned (development only). */
  publicKeyFile?: string;
  allowUnsigned?: boolean;
  /** FIELD_ENCRYPTION_KEYS from the escrow, to open the stored documents. */
  fieldKeys?: string;
  /** Superuser URL to the maintenance database (`postgres`). */
  adminUrl: string;
  ageBin?: string;
}): Promise<RestoreReport> {
  const age = options.ageBin ?? 'age';
  requireTool(age, 'install age (macOS: brew install age; Debian/Ubuntu: apt install age)');
  requireTool('psql', 'install the PostgreSQL client tools (pg_dump, psql)');
  requireTool('tar', 'tar is required to open the stored documents');

  const checks: RestoreReport['checks'] = [];
  const done = () => ({ ok: checks.every((c) => c.ok), checks });

  let manifest: AuditAnchor;
  try {
    manifest = readManifest(options.manifestFile);
  } catch (error) {
    checks.push({ name: 'manifest', ok: false, detail: (error as Error).message });
    return done();
  }

  if (options.publicKeyFile) {
    const receipt = verifyReceipt(options.manifestFile, options.publicKeyFile);
    checks.push({ name: 'independent signature (pull receipt)', ok: receipt.ok, detail: receipt.detail });
    if (!receipt.ok) return done();
  } else if (options.allowUnsigned) {
    checks.push({ name: 'independent signature (pull receipt)', ok: true, detail: 'SKIPPED (development)' });
  } else {
    checks.push({
      name: 'independent signature (pull receipt)',
      ok: false,
      detail: 'set BACKUP_SIGNING_PUBLIC_KEY_FILE: an unsigned set is not accepted',
    });
    return done();
  }

  const verified = await verifySet(options.manifestFile);
  checks.push({
    name: 'both archives match the manifest',
    ok: verified.ok,
    detail: verified.problems.join('; ') || undefined,
  });
  if (!verified.ok) return done();
  const dir = join(options.manifestFile, '..');

  const admin = new pg.Client({ connectionString: options.adminUrl });
  await admin.connect();
  const scratchUrl = new URL(options.adminUrl);
  scratchUrl.pathname = `/${RESTORE_TEST_DATABASE}`;
  const scratchDir = mkdtempSync(join(tmpdir(), 'kayas-restore-'));
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
      createReadStream(join(dir, manifest.artifacts.database.file)).pipe(open.stdin!);
      open.stdout!.pipe(load.stdin!);
      await Promise.all([run(open, 'age -d (database)'), run(load, 'psql')]);
      checks.push({ name: 'decrypt and restore the database', ok: true });
    } catch (error) {
      checks.push({ name: 'decrypt and restore the database', ok: false, detail: (error as Error).message });
      return done();
    }

    try {
      const open = spawn(age, ['-d', '-i', options.identityFile], { stdio: ['pipe', 'pipe', 'pipe'] });
      const untar = spawn('tar', ['-xf', '-', '-C', scratchDir], { stdio: ['pipe', 'ignore', 'pipe'] });
      createReadStream(join(dir, manifest.artifacts.files.file)).pipe(open.stdin!);
      open.stdout!.pipe(untar.stdin!);
      await Promise.all([run(open, 'age -d (documents)'), run(untar, 'tar -x')]);
      const n = countStoreFiles(scratchDir);
      checks.push({
        name: 'stored documents restored',
        ok: n === manifest.fileCount,
        detail: `${n}/${manifest.fileCount}`,
      });
    } catch (error) {
      checks.push({ name: 'stored documents restored', ok: false, detail: (error as Error).message });
      return done();
    }

    if (!options.fieldKeys) {
      checks.push({
        name: 'stored documents open with the escrowed keys',
        ok: false,
        detail:
          'set FIELD_ENCRYPTION_KEYS from the key escrow: the age key alone does not open the documents',
      });
    } else {
      const store = createDiskStore(scratchDir, parseKeyring(options.fieldKeys));
      let opened = 0;
      let bad = 0;
      for (const id of await store.ids()) {
        try {
          await store.get(id);
          opened += 1;
        } catch {
          bad += 1;
        }
      }
      checks.push({
        name: 'stored documents open with the escrowed keys',
        ok: bad === 0,
        detail: `${opened} opened, ${bad} failed`,
      });
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
        ok: c.n >= manifest.counts.audit_event,
        detail: `${c.n} ≥ ${manifest.counts.audit_event}`,
      });

      const chain = await verifyAuditChain(db);
      checks.push({
        name: 'audit chain',
        ok: chain.ok,
        detail: chain.ok ? `${chain.checked} events` : `broken at ${chain.brokenId}`,
      });

      let anchored = manifest.lastEventId === null;
      if (manifest.lastEventId !== null) {
        const { rows } = await db.query(`select encode(hash, 'hex') as hash from audit_event where id = $1`, [
          manifest.lastEventId,
        ]);
        anchored = rows[0]?.hash === manifest.lastHash;
      }
      checks.push({
        name: 'anchored event hash',
        ok: anchored,
        detail: `event ${manifest.lastEventId ?? '(none)'}`,
      });
    } finally {
      await db.end();
    }
    return done();
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
    await admin.query(`drop database if exists "${RESTORE_TEST_DATABASE}" with (force)`);
    await admin.end();
  }
}
