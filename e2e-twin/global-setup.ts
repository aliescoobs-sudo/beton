import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TRAINING_TEST_DATABASE, ensureRoles, recreateDatabase } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import { seedTraining } from '../scripts/seed-training';
import { seedTwin } from '../scripts/seed/twin/index';
import { testEnv } from '../tests/db-env';

/**
 * A fresh scratch database holding the twin: migrations, the training seed in profile twin-base (the accounts, the plants, the marker), then the twin seed. The owner's
 * address and password are read from the credentials file the seed issued (a private temporary file, deleted at once) and handed to the spec through the environment of
 * this run; they are never printed. Fictitious data only: the database is the scratch training database, which the database scripts may drop.
 */
export default async function globalSetup() {
  // the provenance check of the training seed accepts a scratch database only when a test runner says so
  process.env.E2E_TEST_RUNNER = 'playwright';
  const env = testEnv(TRAINING_TEST_DATABASE);
  const training = { ...env, TRAINING_MODE: true as const, APP_ENV: 'training' as const };
  if (training.REAL_DATA || process.env.NODE_ENV === 'production')
    throw new Error('twin e2e refused: not a test environment');
  await ensureRoles(training, env.DATABASE_URL_SEED);
  await recreateDatabase(training, TRAINING_TEST_DATABASE);
  await runMigrations(env.DATABASE_URL_MIGRATOR);
  const dir = mkdtempSync(path.join(tmpdir(), 'kayas-twin-e2e-'));
  const file = path.join(dir, 'training-accounts.local.txt');
  try {
    await seedTraining({
      provenance: 'unverified-test-database',
      profile: 'twin-base',
      env: training,
      today: '2026-11-15',
      credentialsFile: file,
    });
    const text = readFileSync(file, 'utf8');
    const block = text.split(/\n\s*\n/).find((b) => /^Propriétaire/.test(b.trim()));
    const email = /e-mail : (\S+)/.exec(block ?? '')?.[1];
    const password = /mot de passe : (\S+)/.exec(block ?? '')?.[1];
    if (!email || !password)
      throw new Error('twin e2e: the owner account was not found in the credentials file');
    process.env.TWIN_OWNER_EMAIL = email;
    process.env.TWIN_OWNER_PASSWORD = password;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const result = await seedTwin({ env: training, flag: 'true' });
  if (!result.applied) throw new Error('twin e2e: the twin seed did not apply on a fresh database');
}
