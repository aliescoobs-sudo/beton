// Applies db/migrations as the migrator role.
//   corepack pnpm db:migrate
import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { installJobQueue } from '../src/modules/clock/service/job-scheduler.ts';
import { handleHelp } from './cli-help';

export const MIGRATIONS_FOLDER = 'db/migrations';

export async function runMigrations(migratorUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: migratorUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
  // pg-boss owns its schema (T23); it is installed with the migrator and handed to the system role.
  await installJobQueue(migratorUrl);
}

if (import.meta.main) {
  handleHelp(import.meta.url);
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  const { loadEnv } = await import('../src/lib/env.ts');
  await runMigrations(loadEnv(process.env).DATABASE_URL_MIGRATOR);
  console.log('Migrations applied');
}
