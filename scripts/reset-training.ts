// Wipes the training database and seeds it again (T1). Only a database that carries the training marker (or is empty of one and of
// business records) is ever dropped; anything else is refused. Needs the database superuser password (the maintenance environment).
//   corepack pnpm reset:training         stop the app first (./scripts/ops/reset-training.sh does)
import { existsSync } from 'node:fs';
import pg from 'pg';
import { ensureDatabase, superuserUrl } from './db-bootstrap.ts';
import { runMigrations } from './db-migrate.ts';
import { seedTraining } from './seed-training.ts';

export async function wipeTrainingDatabase(env: Parameters<typeof superuserUrl>[0]): Promise<void> {
  const database = new URL(env.DATABASE_URL_MIGRATOR).pathname.slice(1);
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
