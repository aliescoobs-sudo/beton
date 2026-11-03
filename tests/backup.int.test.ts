import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countStoreFiles,
  createBackup,
  generateSigningKeys,
  ingestSets,
  MANIFEST_SUFFIX,
  readManifest,
  restoreCheck,
  signReceipt,
  verifySet,
} from '../scripts/backup-lib';
import { superuserUrl, TEST_DATABASE } from '../scripts/db-bootstrap';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createDiskStore } from '../src/lib/files/store';
import { testEnv } from './db-env';
import { realActor } from './helpers/actors';

// AC-SEC-12 + CP2 audit anchor + C2 (CODEX-REVIEW-R9 items 1, 8, 9): one set = database + stored documents + manifest, an
// independent signature, freshness and completeness. Needs `age` and the dev identity file from .env.ops.
const env = testEnv();
const identityFile = process.env.BACKUP_AGE_IDENTITY_FILE ?? '';
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 1 });
const work = mkdtempSync(join(tmpdir(), 'belgobeton-backup-'));
const dir = join(work, 'backups');
const fileStore = join(work, 'file-store');
const keys = generateSigningKeys(join(work, 'keys'));
const other = generateSigningKeys(join(work, 'other-keys'));
const SECRET_TEXT = 'BL scan of the client Zniber, 14 m3 B25';
afterAll(async () => {
  await app.end();
  rmSync(work, { recursive: true, force: true });
});

// A real owner: the database checks the request role against the stored role (DECISIONS 76).
let ownerId = '';
let backup: Awaited<ReturnType<typeof createBackup>>;
const manifestPath = () => backup.manifestFile;

beforeAll(async () => {
  ownerId = (await realActor(env.DATABASE_URL_MIGRATOR, 'owner')).id;
  const store = createDiskStore(fileStore, parseKeyring(env.FIELD_ENCRYPTION_KEYS));
  for (let i = 0; i < 3; i++) await store.put(randomUUID(), Buffer.from(`${SECRET_TEXT} #${i}`));
  for (let i = 0; i < 3; i++) {
    await withRlsContext(app, { userId: ownerId, role: 'owner', requestId: `backup-${randomUUID()}` }, (tx) =>
      tx.query(`select audit.record('export', 'backup_test', null, null, null, 'seed')`),
    );
  }
  backup = await createBackup({
    backupUrl: env.DATABASE_URL_BACKUP,
    recipient: env.BACKUP_AGE_RECIPIENT,
    dir,
    fileStoreDir: fileStore,
  });
  await signReceipt(backup.manifestFile, keys.privateKeyFile);
}, 90_000);

const restore = (overrides: Partial<Parameters<typeof restoreCheck>[0]> = {}) =>
  restoreCheck({
    manifestFile: manifestPath(),
    identityFile,
    publicKeyFile: keys.publicKeyFile,
    fieldKeys: env.FIELD_ENCRYPTION_KEYS,
    adminUrl: superuserUrl(env, 'postgres'),
    ...overrides,
  });

/** A copy of the set in its own directory, so that a test can damage it. */
function copySet(name: string): string {
  const copy = join(work, name);
  mkdirSync(copy, { recursive: true });
  for (const f of backup.files) cpSync(f, join(copy, f.split('/').pop()!));
  for (const f of readdirSync(dir).filter((x) => x.includes('.pull-receipt')))
    cpSync(join(dir, f), join(copy, f));
  return join(copy, manifestPath().split('/').pop()!);
}

describe('one backup set covers the database AND the stored documents (item 1)', () => {
  it('has both archives and the manifest, and no readable content in either archive', () => {
    const m = readManifest(manifestPath());
    expect(m.schema).toBe(2);
    expect(m.fileCount).toBe(3);
    for (const art of [m.artifacts.database, m.artifacts.files]) {
      const bytes = readFileSync(join(dir, art.file));
      expect(bytes.subarray(0, 21).toString('utf8')).toBe('age-encryption.org/v1');
      expect(art.sha256).toMatch(/^[0-9a-f]{64}$/);
      const text = bytes.toString('latin1');
      for (const word of ['CREATE TABLE', 'audit_event', 'INSERT INTO', 'argon2id', SECRET_TEXT])
        expect(text).not.toContain(word);
    }
  });

  it('writes the files without any world access and leaves no half-written file behind', () => {
    for (const f of backup.files) expect(statSync(f).mode & 0o007).toBe(0);
    expect(readdirSync(dir).filter((f) => f.endsWith('.partial'))).toEqual([]);
  });

  it('anchors the latest audit event, outside the database', async () => {
    const anchor = readManifest(manifestPath());
    const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
    const { rows } = await migrator.query(
      `select id::text, encode(hash, 'hex') as hash from audit_event where id = $1`,
      [anchor.lastEventId],
    );
    await migrator.end();
    expect(rows[0]).toEqual({ id: anchor.lastEventId, hash: anchor.lastHash });
    expect(anchor.database).toBe(TEST_DATABASE);
  });

  it('a wrong or missing file store directory fails the backup instead of backing up "nothing"', async () => {
    expect(() => countStoreFiles(join(work, 'does-not-exist'))).toThrow(/does not exist/);
    await expect(
      createBackup({
        backupUrl: env.DATABASE_URL_BACKUP,
        recipient: env.BACKUP_AGE_RECIPIENT,
        dir: join(work, 'never'),
        fileStoreDir: join(work, 'does-not-exist'),
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('a failed dump leaves no manifest and no partial file, so nothing incomplete can be pulled', async () => {
    const failing = join(work, 'failing');
    const bad = new URL(env.DATABASE_URL_BACKUP);
    bad.pathname = '/no_such_database';
    await expect(
      createBackup({
        backupUrl: bad.toString(),
        recipient: env.BACKUP_AGE_RECIPIENT,
        dir: failing,
        fileStoreDir: fileStore,
      }),
    ).rejects.toThrow();
    expect(existsSync(failing) ? readdirSync(failing) : []).toEqual([]);
  });

  it('explains how to install age when it is missing', async () => {
    await expect(
      createBackup({
        backupUrl: env.DATABASE_URL_BACKUP,
        recipient: env.BACKUP_AGE_RECIPIENT,
        dir,
        fileStoreDir: fileStore,
        ageBin: 'age-not-installed',
      }),
    ).rejects.toThrow(/install age/i);
  });
});

describe('restore test (items 1 and 9)', () => {
  it('restores the database and the documents, checks the office signature and opens every document with the escrowed keys', async () => {
    const report = await restore();
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      'independent signature (pull receipt)',
      'both archives match the manifest',
      'decrypt and restore the database',
      'stored documents restored',
      'stored documents open with the escrowed keys',
      'migrations',
      'audit_event row count',
      'audit chain',
      'anchored event hash',
    ]);
  }, 90_000);

  it('does not accept a set without a signed receipt, nor one signed by another key', async () => {
    const unsigned = copySet('unsigned');
    for (const f of readdirSync(join(unsigned, '..')).filter((x) => x.includes('.pull-receipt')))
      rmSync(join(unsigned, '..', f));
    const none = await restore({ manifestFile: unsigned });
    expect(none.ok).toBe(false);
    expect(none.checks[0]).toMatchObject({ name: 'independent signature (pull receipt)', ok: false });

    const wrongKey = await restore({ publicKeyFile: other.publicKeyFile });
    expect(wrongKey.ok).toBe(false);
    expect(wrongKey.checks[0]?.detail).toMatch(/invalid/);

    const noKey = await restore({ publicKeyFile: undefined });
    expect(noKey.ok).toBe(false);
    expect(noKey.checks[0]?.detail).toMatch(/BACKUP_SIGNING_PUBLIC_KEY_FILE/);
  });

  it('fails when the manifest was rewritten after the office signed it (a forged anchor)', async () => {
    const forged = copySet('forged');
    const anchor = readManifest(forged);
    writeFileSync(forged, JSON.stringify({ ...anchor, lastHash: '00'.repeat(32) }));
    const report = await restore({ manifestFile: forged });
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.detail).toMatch(/differs from what the office signed/);
  });

  it('fails when an archive was altered', async () => {
    const tampered = copySet('tampered');
    const m = readManifest(tampered);
    const file = join(tampered, '..', m.artifacts.files.file);
    const bytes = readFileSync(file);
    bytes[bytes.length - 10] = (bytes[bytes.length - 10] ?? 0) ^ 0xff;
    writeFileSync(file, bytes);
    const report = await restore({ manifestFile: tampered });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => !c.ok)).toMatchObject({ name: 'both archives match the manifest' });
  });

  it('fails without the escrowed keys or with the wrong ones: the age key alone does not open the documents', async () => {
    const without = await restore({ fieldKeys: undefined });
    expect(without.ok).toBe(false);
    expect(without.checks.find((c) => !c.ok)?.name).toBe('stored documents open with the escrowed keys');
    const wrong = await restore({ fieldKeys: `x1:${Buffer.alloc(32, 5).toString('base64')}` });
    expect(wrong.ok).toBe(false);
    expect(wrong.checks.find((c) => !c.ok)?.detail).toMatch(/3 failed/);
  }, 90_000);

  it('refuses an old-format manifest (a set without the documents)', async () => {
    const old = join(work, 'old.audit-anchor.json');
    writeFileSync(old, JSON.stringify({ backupFile: 'x.sql.age', backupSha256: '00' }));
    const report = await restore({ manifestFile: old });
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.detail).toMatch(/old backup manifest/);
  });
});

describe('the pull verifies freshness and completeness and signs what it took (item 8)', () => {
  const stage = (name: string, edit?: (dir: string) => void) => {
    const s = join(work, name);
    mkdirSync(s, { recursive: true });
    for (const f of backup.files) cpSync(f, join(s, f.split('/').pop()!));
    edit?.(s);
    return s;
  };
  const ingest = (staging: string, store: string, maxAgeMs = 3_600_000, now?: Date) =>
    ingestSets({
      staging,
      store,
      privateKeyFile: keys.privateKeyFile,
      maxAgeMs,
      keep: 30,
      ...(now ? { now } : {}),
    });

  it('takes a complete, fresh set and signs a receipt for it', async () => {
    const store = join(work, 'store-ok');
    const result = await ingest(stage('stage-ok'), store);
    expect(result.problems).toEqual([]);
    expect(result.added).toHaveLength(1);
    expect(readdirSync(store).some((f) => f.endsWith('.pull-receipt.sig'))).toBe(true);
    expect((await verifySet(join(store, manifestPath().split('/').pop()!))).ok).toBe(true);
  });

  it('reports a stale set', async () => {
    const result = await ingest(
      stage('stage-stale'),
      join(work, 'store-stale'),
      3_600_000,
      new Date(Date.now() + 5 * 3_600_000),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/older than/);
  });

  it('never takes a set without its manifest, nor one with a truncated archive', async () => {
    const noManifest = await ingest(
      stage('stage-nomanifest', (s) => rmSync(join(s, manifestPath().split('/').pop()!))),
      join(work, 'store-nm'),
    );
    expect(noManifest.ok).toBe(false);
    expect(noManifest.problems.join(' ')).toMatch(/no complete backup set/);
    expect(readdirSync(join(work, 'store-nm'))).toEqual([]);

    const truncated = await ingest(
      stage('stage-trunc', (s) => {
        const art = readManifest(join(s, manifestPath().split('/').pop()!)).artifacts.database.file;
        writeFileSync(join(s, art), readFileSync(join(s, art)).subarray(0, 100));
      }),
      join(work, 'store-trunc'),
    );
    expect(truncated.ok).toBe(false);
    expect(truncated.problems.join(' ')).toMatch(/does not match the manifest/);
    expect(readdirSync(join(work, 'store-trunc'))).toEqual([]);
  });

  it('reports a server copy that differs from the set the office signed earlier, and repairs a damaged local copy', async () => {
    const store = join(work, 'store-repair');
    await ingest(stage('stage-first'), store);
    const name = manifestPath().split('/').pop()!;
    // the server now offers the same stamp with another manifest
    const rewritten = stage('stage-rewritten', (s) => {
      const m = readManifest(join(s, name));
      writeFileSync(
        join(s, name),
        JSON.stringify({ ...m, counts: { audit_event: m.counts.audit_event + 1 } }),
      );
    });
    const swapped = await ingest(rewritten, store);
    expect(swapped.ok).toBe(false);
    expect(swapped.problems.join(' ')).toMatch(/differs from the set the office signed/);
    // a damaged local archive is replaced from a good server copy (no "ignore existing")
    const m = readManifest(join(store, name));
    writeFileSync(join(store, m.artifacts.files.file), 'damaged');
    const repaired = await ingest(stage('stage-again'), store);
    expect(repaired.ok).toBe(true);
    expect((await verifySet(join(store, name))).ok).toBe(true);
  });

  it('keeps only the newest sets', async () => {
    const store = join(work, 'store-prune');
    await ingest(stage('stage-p1'), store);
    const pruned = await ingestSets({
      staging: stage('stage-p2'),
      store,
      privateKeyFile: keys.privateKeyFile,
      maxAgeMs: 3_600_000,
      keep: 1,
    });
    expect(pruned.ok).toBe(true);
    expect(readdirSync(store).filter((f) => f.endsWith(MANIFEST_SUFFIX))).toHaveLength(1);
  });
});
