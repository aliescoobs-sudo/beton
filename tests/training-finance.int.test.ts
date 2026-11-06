import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRAINING_TEST_DATABASE, ensureRoles, recreateDatabase } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import { seedTraining } from '../scripts/seed-training';
import { executeFinance, exportAccountant, getFinanceReport } from '../src/modules/finance';
import { resolveAuthState } from '../src/modules/platform-security/auth/session-gate';
import { authTestKit } from './auth-helpers';
import { testEnv } from './db-env';

// R11-08: finance in the training instance keeps its REAL authenticator. The seed switches the module on; a password-only training sign-in
// is still refused by finance (no bypass); the same account enrols a real TOTP of its own accord and then reads, writes and exports.
const env = testEnv(TRAINING_TEST_DATABASE);
const training = { ...env, TRAINING_MODE: true as const, APP_ENV: 'training' as const };
const kitEnv = {
  DATABASE_URL_APP: env.DATABASE_URL_APP,
  DATABASE_URL_AUTH: env.DATABASE_URL_AUTH,
  DATABASE_URL_SYSTEM: env.DATABASE_URL_SYSTEM,
  DATABASE_URL_MIGRATOR: env.DATABASE_URL_MIGRATOR,
};
const kit = authTestKit(kitEnv);
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const admin = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
admin.on('error', () => undefined);
kit.authPool.on('error', () => undefined);
let ownerEmail = '';
let ownerPassword = '';

beforeAll(async () => {
  await ensureRoles(training, env.DATABASE_URL_SEED);
  await recreateDatabase(training, TRAINING_TEST_DATABASE);
  await runMigrations(env.DATABASE_URL_MIGRATOR);
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-tfin-'));
  chmodSync(dir, 0o700);
  const file = path.join(dir, 'training-accounts.local.txt');
  await seedTraining({ provenance: 'unverified-test-database', env: training, today: new Date().toISOString().slice(0, 10), credentialsFile: file });
  // the test reads its own credentials file, as the operator would
  const text = readFileSync(file, 'utf8').split('\n');
  const at = text.findIndex((l) => l.startsWith('Propriétaire') || l.includes('(owner)'));
  ownerEmail = /e-mail : (\S+)/.exec(text[at + 1] ?? '')![1]!;
  ownerPassword = /mot de passe : (\S+)/.exec(text[at + 2] ?? '')![1]!;
}, 600_000);
afterAll(async () => {
  await Promise.all([app.end(), admin.end(), kit.close()]);
});

const stateOf = async (cookie: string) =>
  resolveAuthState(kit.auth, new Headers({ cookie }), { trainingMode: true });

describe('finance in the training instance (R11-08)', () => {
  it('the seed switched the module on in the database', async () => {
    const r = await admin.query<{ n: string }>(
      `select count(*)::text n from finance.finance_setting where enabled = true`,
    );
    expect(Number(r.rows[0]!.n)).toBe(1);
  });

  it('a password-only training sign-in is refused by finance: no bypass', async () => {
    const cookie = kit.cookieOf(
      await kit.call('/sign-in/email', { email: ownerEmail, password: ownerPassword }),
    );
    const state = await stateOf(cookie);
    expect(state.kind).toBe('authenticated');
    if (state.kind !== 'authenticated') return;
    expect(state.user.twoFactorEnabled).toBe(false);
    const session = { user: state.user, twoFactorAt: state.session.twoFactorAt };
    await expect(
      executeFinance(app, session, {
        action: 'entry',
        recurrenceMonths: 1,
        date: '2026-11-05',
        dueDate: '2026-11-30',
        kind: 'expense',
        amountCentimes: 1000,
        reference: 'sans-totp',
      }),
    ).rejects.toThrow(/FINANCE_UNAVAILABLE/);
    await expect(getFinanceReport(app, state.user, '2026-11-01', '2026-11-30')).rejects.toThrow(
      /FINANCE_UNAVAILABLE/,
    );
    await expect(exportAccountant(app, state.user, '2026-11-01', '2026-11-30')).rejects.toThrow(
      /FINANCE_UNAVAILABLE/,
    );
  });

  it('after the optional enrolment of a real authenticator, the same account reads, writes and exports', async () => {
    const first = kit.cookieOf(
      await kit.call('/sign-in/email', { email: ownerEmail, password: ownerPassword }),
    );
    const enable = await kit.call('/two-factor/enable', { password: ownerPassword }, { cookie: first });
    expect(enable.status).toBe(200);
    const userId = (await admin.query<{ id: string }>(`select id from "user" where email = $1`, [ownerEmail]))
      .rows[0]!.id;
    const verify = await kit.call(
      '/two-factor/verify-totp',
      { code: await kit.totpFor(userId) },
      { cookie: first },
    );
    expect(verify.status).toBe(200);
    const state = await stateOf(kit.cookieOf(verify));
    expect(state.kind).toBe('authenticated');
    if (state.kind !== 'authenticated') return;
    expect(state.user.twoFactorEnabled).toBe(true);
    expect(state.session.twoFactorAt).not.toBeNull();
    const session = { user: state.user, twoFactorAt: state.session.twoFactorAt };

    // write
    const made = await executeFinance(app, session, {
      action: 'entry',
      recurrenceMonths: 1,
      date: new Date().toISOString().slice(0, 10),
      dueDate: new Date().toISOString().slice(0, 10),
      kind: 'expense',
      amountCentimes: 123_400,
      reference: 'formation-loyer',
    });
    expect((made as { id: string }).id).toBeTruthy();
    // read
    const month = new Date().toISOString().slice(0, 7);
    const report = await getFinanceReport(app, state.user, `${month}-01`, `${month}-28`);
    expect(JSON.stringify(report)).toContain('123400');
    // export
    const workbook = await exportAccountant(app, state.user, `${month}-01`, `${month}-28`);
    expect(Buffer.from(workbook as Uint8Array).byteLength).toBeGreaterThan(500);
  });
});
