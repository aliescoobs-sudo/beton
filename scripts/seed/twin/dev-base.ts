// Developer helper (T20): rebuilds the scratch training database (belgobeton_training_test) with migrations and the twin-base training seed.
// Not used by CI. Needs the local database up (corepack pnpm db:up).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TRAINING_TEST_DATABASE, ensureRoles, recreateDatabase } from '../../db-bootstrap';
import { runMigrations } from '../../db-migrate';
import { seedTraining } from '../../seed-training';
import { testEnv } from '../../../tests/db-env';

const env = testEnv(TRAINING_TEST_DATABASE);
const training = { ...env, TRAINING_MODE: true as const, APP_ENV: 'training' as const };
await ensureRoles(training, env.DATABASE_URL_SEED);
await recreateDatabase(training, TRAINING_TEST_DATABASE);
await runMigrations(env.DATABASE_URL_MIGRATOR);
const dir = mkdtempSync(path.join(tmpdir(), 'bb-twin-'));
const r = await seedTraining({
  provenance: 'unverified-test-database',
  profile: 'twin-base',
  env: training,
  today: '2026-11-15',
  credentialsFile: path.join(dir, 'training-accounts.local.txt'),
});
console.log('base', r.applied, r.accounts);

// optional second step: `-- --twin` runs the twin on top
if (process.argv.includes('--twin')) {
  const { seedTwin } = await import('./index.ts');
  const r = await seedTwin({ env: training, flag: 'true' });
  console.log('twin', r);
}
