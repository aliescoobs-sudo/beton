import { ensureRoles, recreateTestDatabase } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import { testEnv } from './db-env';

/** Vitest global setup for integration tests: a fresh, migrated test database on every run. */
export default async function setup() {
  const env = testEnv();
  try {
    await ensureRoles(env);
    await recreateTestDatabase(env);
    await runMigrations(env.DATABASE_URL_MIGRATOR);
  } catch (error) {
    const cause =
      error instanceof Error && error.cause instanceof Error ? `\nCause: ${error.cause.message}` : '';
    throw new Error(
      `Cannot prepare the test database (is it up? corepack pnpm db:up)\n${String(error)}${cause}`,
    );
  }
}
