import { runMigrations } from '../scripts/db-migrate';
import { testEnv } from './db-env';

/** Vitest global setup for integration tests: migrate the test database once. */
export default async function setup() {
  const env = testEnv();
  try {
    await runMigrations(env.DATABASE_URL_MIGRATOR);
  } catch (error) {
    throw new Error(
      `Cannot migrate the test database. Start it with: corepack pnpm db:up && corepack pnpm db:bootstrap\n${String(error)}`,
    );
  }
}
