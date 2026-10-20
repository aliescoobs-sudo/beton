import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { symmetricEncrypt } from 'better-auth/crypto';
import { parseKeyring } from '../src/lib/crypto/keyring';
import {
  ENCRYPTED_COLUMNS,
  type EncryptedColumn,
} from '../src/modules/platform-security/domain/encrypted-columns';
import { authSecretCipher } from '../src/modules/platform-security/auth/secret-cipher';
import { countOnOldKeys, rotateColumn } from '../src/modules/platform-security/service/key-rotation';
import { authTestKit } from './auth-helpers';

const kit = authTestKit();
afterAll(() => kit.close());
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-23T08:00:10Z') }));
afterEach(() => vi.useRealTimers());

const newKey = (id: string) =>
  `${id}:${Buffer.from(randomUUID() + randomUUID())
    .subarray(0, 32)
    .toString('base64')}`;

describe('key rotation (T16, AC-SEC-10)', () => {
  it('moves recovery codes to a new key; afterwards the old key can be removed and the codes still work', async () => {
    const user = await kit.enrolledUser();
    const current = kit.env.RECOVERY_CODES_KEYS;
    const next = newKey('r9');
    const spec = ENCRYPTED_COLUMNS.find((c) => c.table === 'twoFactor')!;

    const result = await rotateColumn(kit.authPool, spec, parseKeyring(`${next},${current}`));
    expect(result.remaining).toBe(0);
    expect(result.rotated).toBeGreaterThan(0);

    const { rows } = await kit.migrator.query(`select "backupCodes" from "twoFactor" where "userId" = $1`, [
      user.id,
    ]);
    expect(rows[0].backupCodes.startsWith('f1.r9.')).toBe(true);
    for (const code of user.backupCodes) expect(rows[0].backupCodes).not.toContain(code);

    // Old key removed from the keyring: a recovery-code login still works.
    const rotatedKit = authTestKit({ RECOVERY_CODES_KEYS: next });
    try {
      vi.setSystemTime(Date.now() + 30_000);
      const pending = rotatedKit.cookieOf(
        await rotatedKit.call('/sign-in/email', { email: user.email, password: kit.password }),
      );
      const res = await rotatedKit.call(
        '/two-factor/verify-backup-code',
        { code: user.backupCodes[0] },
        { cookie: pending },
      );
      expect(res.status).toBe(200);
    } finally {
      await rotatedKit.close();
    }
  });

  it('rotates any registered column and is safe to run twice', async () => {
    const pool = new pg.Pool({ connectionString: kit.env.DATABASE_URL_MIGRATOR, max: 1 });
    const k1 = newKey('k1');
    const k2 = newKey('k2');
    const spec: EncryptedColumn = {
      table: 'rotation_probe',
      column: 'secret',
      idColumn: 'id',
      keyring: 'FIELD_ENCRYPTION_KEYS',
      pool: 'app',
    };
    try {
      await pool.query('create table public.rotation_probe (id int primary key, secret text)');
      const old = parseKeyring(k1);
      await pool.query('insert into rotation_probe values (1, $1), (2, $2), (3, null)', [
        old.encrypt('+212 600-000-001'),
        old.encrypt('+212 600-000-002'),
      ]);
      const ring = parseKeyring(`${k2},${k1}`);
      expect(await countOnOldKeys(pool, spec, ring)).toBe(2);
      expect((await rotateColumn(pool, spec, ring)).rotated).toBe(2);
      expect((await rotateColumn(pool, spec, ring)).rotated).toBe(0);

      const { rows } = await pool.query('select secret from rotation_probe where id = 1');
      expect(rows[0].secret).toMatch(/^f1\.k2\./);
      expect(rows[0].secret).not.toContain('600-000');
      expect(parseKeyring(k2).decrypt(rows[0].secret)).toBe('+212 600-000-001');
    } finally {
      await pool.query('drop table if exists public.rotation_probe');
      await pool.end();
    }
  });

  describe('TOTP secrets', () => {
    const registered = ENCRYPTED_COLUMNS.filter((c) => c.keyring === 'AUTH_SECRETS').map(
      (c) => `${c.table}.${c.column}`,
    );

    it('are registered for rotation (enrolled and pending seeds)', () => {
      expect(registered).toEqual(['twoFactor.secret', 'two_factor_pending.secret']);
    });

    it('are sealed with the versioned Better Auth secret at enrolment', async () => {
      const user = await kit.enrolledUser();
      const { rows } = await kit.migrator.query(`select secret from "twoFactor" where "userId" = $1`, [
        user.id,
      ]);
      expect(rows[0].secret.startsWith('$ba$1$')).toBe(true);
    });

    it('move to a new version (and from bare pre-versioning values); the old version can then go', async () => {
      // A scratch table: rotating "twoFactor" itself would re-seal every user other suites are logging in with.
      const pool = new pg.Pool({ connectionString: kit.env.DATABASE_URL_MIGRATOR, max: 1 });
      const spec: EncryptedColumn = {
        table: 'totp_rotation_probe',
        column: 'secret',
        idColumn: 'id',
        keyring: 'AUTH_SECRETS',
        pool: 'auth',
      };
      const v1 = authSecretCipher(kit.env);
      const next = `2:${randomUUID()}${randomUUID()}`;
      const rotating = authSecretCipher({
        AUTH_SECRET: kit.env.AUTH_SECRET,
        AUTH_SECRETS: `${next},1:${kit.env.AUTH_SECRET}`,
      });
      try {
        await pool.query('create table public.totp_rotation_probe (id int primary key, secret text)');
        const bare = await symmetricEncrypt({ key: kit.env.AUTH_SECRET, data: 'SEED-B' });
        await pool.query('insert into totp_rotation_probe values (1, $1), (2, $2), (3, null)', [
          await v1.encrypt('SEED-A'),
          bare,
        ]);
        expect(await countOnOldKeys(pool, spec, rotating)).toBe(2);
        expect((await rotateColumn(pool, spec, rotating)).remaining).toBe(0);
        expect((await rotateColumn(pool, spec, rotating)).rotated).toBe(0);

        const { rows } = await pool.query(
          'select id, secret from totp_rotation_probe where id < 3 order by id',
        );
        expect(rows.every((r) => r.secret.startsWith('$ba$2$'))).toBe(true);
        const alone = authSecretCipher({ AUTH_SECRET: kit.env.AUTH_SECRET, AUTH_SECRETS: next });
        expect(await alone.decrypt(rows[0].secret)).toBe('SEED-A');
        expect(await alone.decrypt(rows[1].secret)).toBe('SEED-B');
      } finally {
        await pool.query('drop table if exists public.totp_rotation_probe');
        await pool.end();
      }
    });

    it('still verify at login when the secrets list gains a newer version in front', async () => {
      const user = await kit.enrolledUser();
      const next = `2:${randomUUID()}${randomUUID()}`;
      const rotatedKit = authTestKit({ AUTH_SECRETS: `${next},1:${kit.env.AUTH_SECRET}` });
      try {
        vi.setSystemTime(Date.now() + 30_000);
        const pending = rotatedKit.cookieOf(
          await rotatedKit.call('/sign-in/email', { email: user.email, password: kit.password }),
        );
        const code = await kit.totpFor(user.id);
        const res = await rotatedKit.call('/two-factor/verify-totp', { code }, { cookie: pending });
        expect(res.status).toBe(200);
      } finally {
        await rotatedKit.close();
      }
    });
  });
});
