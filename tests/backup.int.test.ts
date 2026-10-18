import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackup, restoreCheck } from '../scripts/backup-lib';
import { superuserUrl, TEST_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { testEnv } from './db-env';
import { realActor } from './helpers/actors';

// AC-SEC-12 + CP2 audit anchor. Needs `age` and the dev identity file from .env.local.
const env = testEnv();
const identityFile = process.env.BACKUP_AGE_IDENTITY_FILE ?? '';
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 1 });
const dir = mkdtempSync(join(tmpdir(), 'belgobeton-backup-'));
afterAll(() => app.end());

// A real owner: the database checks the request role against the stored role (DECISIONS 76).
let ownerId = '';
beforeAll(async () => {
  ownerId = (await realActor(env.DATABASE_URL_MIGRATOR, 'owner')).id;
});
let backup: Awaited<ReturnType<typeof createBackup>>;

beforeAll(async () => {
  for (let i = 0; i < 3; i++) {
    await withRlsContext(app, { userId: ownerId, role: 'owner', requestId: `backup-${randomUUID()}` }, (tx) =>
      tx.query(`select audit.record('export', 'backup_test', null, null, null, 'seed')`),
    );
  }
  backup = await createBackup({
    backupUrl: env.DATABASE_URL_BACKUP,
    recipient: env.BACKUP_AGE_RECIPIENT,
    dir,
  });
}, 60_000);

const restore = (overrides: Partial<Parameters<typeof restoreCheck>[0]> = {}) =>
  restoreCheck({
    backupFile: backup.backupFile,
    anchorFile: backup.anchorFile,
    identityFile,
    adminUrl: superuserUrl(env, 'postgres'),
    ...overrides,
  });

describe('encrypted backup (T18, AC-SEC-12)', () => {
  it('is an age file with no readable SQL in it', () => {
    const bytes = readFileSync(backup.backupFile);
    expect(bytes.subarray(0, 21).toString('utf8')).toBe('age-encryption.org/v1');
    const text = bytes.toString('latin1');
    for (const word of ['CREATE TABLE', 'audit_event', 'INSERT INTO', 'argon2id'])
      expect(text).not.toContain(word);
  });

  it('creates the backup and the anchor readable by their owner only', () => {
    for (const file of [backup.backupFile, backup.anchorFile]) expect(statSync(file).mode & 0o077).toBe(0);
  });

  it('writes an anchor with the latest audit event id and hash, outside the database', async () => {
    const anchor = JSON.parse(readFileSync(backup.anchorFile, 'utf8'));
    const { rows } = await new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 }).query(
      `select id::text, encode(hash, 'hex') as hash from audit_event where id = $1`,
      [anchor.lastEventId],
    );
    expect(rows[0]).toEqual({ id: anchor.lastEventId, hash: anchor.lastHash });
    expect(anchor.database).toBe(TEST_DATABASE);
    expect(anchor.backupSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('restore test', () => {
  it('restores into a scratch database and passes every check', async () => {
    const report = await restore();
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      'backup file matches its anchor',
      'decrypt and restore',
      'migrations',
      'audit_event row count',
      'audit chain',
      'anchored event hash',
    ]);
  }, 60_000);

  it('fails when the restored chain does not match the off-database anchor', async () => {
    const anchor = JSON.parse(readFileSync(backup.anchorFile, 'utf8'));
    const forged = join(dir, 'forged.audit-anchor.json');
    writeFileSync(forged, JSON.stringify({ ...anchor, lastHash: '00'.repeat(32) }));
    const report = await restore({ anchorFile: forged });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'anchored event hash')?.ok).toBe(false);
  }, 60_000);

  it('fails when the backup file was altered', async () => {
    const tampered = join(dir, 'tampered.sql.age');
    const bytes = readFileSync(backup.backupFile);
    const at = bytes.length - 10;
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    writeFileSync(tampered, bytes);
    const report = await restore({ backupFile: tampered });
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ name: 'backup file matches its anchor', ok: false });
  });

  it('explains how to install age when it is missing', async () => {
    await expect(
      createBackup({
        backupUrl: env.DATABASE_URL_BACKUP,
        recipient: env.BACKUP_AGE_RECIPIENT,
        dir,
        ageBin: 'age-not-installed',
      }),
    ).rejects.toThrow(/install age/i);
  });
});
