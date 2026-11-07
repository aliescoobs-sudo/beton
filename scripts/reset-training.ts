// Wipes the training database and seeds it again (T1). Only a database that carries the training marker (or is empty of one and of
// business records) is ever dropped; anything else is refused. Needs the database superuser password (the maintenance environment).
//   corepack pnpm reset:training         stop the app first (./scripts/ops/reset-training.sh does)
import { existsSync } from 'node:fs';
import pg from 'pg';
import { ensureDatabase, superuserUrl } from './db-bootstrap.ts';
import { runMigrations } from './db-migrate.ts';
import { seedTraining } from './seed-training.ts';
import { databaseNameOf, hasBoundBirthRow, isTestRunnerDatabase, mintBirthToken } from './training-birth.ts';

export async function wipeTrainingDatabase(
  env: Parameters<typeof superuserUrl>[0] & {
    TRAINING_MODE?: boolean;
    APP_ENV?: string;
    REAL_DATA?: boolean;
  },
): Promise<void> {
  const database = databaseNameOf(env.DATABASE_URL_MIGRATOR);
  // R14-13: the helper itself checks the mode (it used to rely on its CLI): training on, not production, no real data.
  if (!env.TRAINING_MODE || env.APP_ENV === 'production' || env.REAL_DATA)
    throw new Error(
      'Refusing to wipe: this needs TRAINING_MODE=true, APP_ENV not production and REAL_DATA off.',
    );
  // ...and a birth row BOUND to this database on this cluster (spent or not): a marked database restored on a cluster that never had one,
  // or a row of an earlier version that names no database (R15A-07), cannot be reset here. A throwaway test database of a test runner is the
  // only exception. The operator can bind a legacy row by hand once they have verified the volume is dedicated (CP-TRAINING.md).
  if (!isTestRunnerDatabase(env.DATABASE_URL_MIGRATOR) && !(await hasBoundBirthRow(env, database)))
    throw new Error(
      `Refusing to wipe "${database}": this cluster has no birth row bound to it (no row, or a row that names no database or another one: it was not born through the stock training path, or by an earlier version). Remove the volume and start again. If you have verified that this volume is dedicated to this one database, you may bind the row yourself (see CP-TRAINING.md, step 7).`,
    );
  const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
  try {
    const hasTable = await migrator.query(
      `select 1 from pg_tables where schemaname = 'public' and tablename = 'training_marker'`,
    );
    const marked = hasTable.rowCount
      ? (await migrator.query('select 1 from public.training_marker')).rowCount
      : 0;
    if (!marked)
      throw new Error(
        `Refusing to wipe "${database}": it does not carry the training marker. Only a database made by seed:training is ever reset.`,
      );
  } finally {
    await migrator.end();
  }
  const admin = new pg.Client({ connectionString: superuserUrl(env, 'postgres') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
  await ensureDatabase(env, database);
  await mintBirthToken(env, database); // the operator's reset of a marked training database is a legitimate new birth (R13-01)
}

function requireOutputPath(): string {
  const file = process.env.TRAINING_ACCOUNTS_FILE;
  if (!file)
    throw new Error(
      'TRAINING_ACCOUNTS_FILE is required: the path of the credentials file, in a private folder outside the checkout.',
    );
  return file;
}

if (import.meta.main) {
  const { handleHelp } = await import('./cli-help');
  handleHelp(import.meta.url);
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  if (existsSync('.env.ops')) process.loadEnvFile('.env.ops');
  const { loadMaintenanceEnv, loadSeedUrl } = await import('../src/lib/env.ts');
  const { businessDateOf, realClock } = await import('../src/modules/clock/index.ts');
  try {
    const env = { ...loadMaintenanceEnv(process.env), DATABASE_URL_SEED: loadSeedUrl(process.env) };
    if (!env.TRAINING_MODE || env.APP_ENV === 'production')
      throw new Error('reset:training needs TRAINING_MODE=true and APP_ENV not production');
    const credentialsFile = requireOutputPath(); // before anything is wiped
    await wipeTrainingDatabase(env);
    await runMigrations(env.DATABASE_URL_MIGRATOR);
    const result = await seedTraining({
      env,
      today: businessDateOf(realClock.now()),
      credentialsFile,
    });
    console.log(
      `Training database reset: ${result.accounts} accounts, new credentials written to ${result.credentialsFile} (not shown here).`,
    );
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
