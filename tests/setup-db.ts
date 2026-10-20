import { ensureRoles, recreateTestDatabase } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import pg from 'pg';
import { seedPilotMasterData } from '../src/modules/master-data';
import { testEnv } from './db-env';

/** Vitest global setup for integration tests: a fresh, migrated test database on every run. */
export default async function setup() {
  const env = testEnv();
  try {
    await ensureRoles(env);
    await recreateTestDatabase(env);
    await runMigrations(env.DATABASE_URL_MIGRATOR);
    // The pilot seed (decision 79) is how components and concrete types exist, so the suite exercises it every run.
    const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
    try {
      await seedPilotMasterData(system, { SIMULATION_ENABLED: true, REAL_DATA: false, NODE_ENV: 'test' });
    } finally {
      await system.end();
    }
  } catch (error) {
    const cause =
      error instanceof Error && error.cause instanceof Error ? `\nCause: ${error.cause.message}` : '';
    throw new Error(
      `Cannot prepare the test database (is it up? corepack pnpm db:up)\n${String(error)}${cause}`,
    );
  }
}
