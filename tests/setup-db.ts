import { ensureRoles, recreateTestDatabase } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import pg from 'pg';
import { seedPilotMasterData } from '../src/modules/master-data';
import { testEnv } from './db-env';

/** Vitest global setup for integration tests: a fresh, migrated test database on every run. */
export default async function setup() {
  const env = testEnv();
  try {
    await ensureRoles(env, env.DATABASE_URL_SEED);
    await recreateTestDatabase(env);
    await runMigrations(env.DATABASE_URL_MIGRATOR);
    // R18-03: the reserved-role boundary of the database (migration 0220) is ON everywhere a server runs. The ~90 policy-matrix tests that
    // drive the reserved roles (partner, support) as DB actors run in THIS test database with it off; tests/r18-03-reserved-boundary.int.test.ts
    // switches it on for its own cases and back, and the server refuses to start on a database where it is off (assertReservedBoundaryOn).
    await setReservedBoundary(env.DATABASE_URL_MIGRATOR, false);
    // The pilot seed (decision 79) is how components and concrete types exist, so the suite exercises it every run.
    const seed = new pg.Pool({ connectionString: env.DATABASE_URL_SEED, max: 1 });
    try {
      await seedPilotMasterData(seed, { SIMULATION_ENABLED: true, REAL_DATA: false, NODE_ENV: 'test' });
    } finally {
      await seed.end();
    }
  } catch (error) {
    const cause =
      error instanceof Error && error.cause instanceof Error ? `\nCause: ${error.cause.message}` : '';
    throw new Error(
      `Cannot prepare the test database (is it up? corepack pnpm db:up)\n${String(error)}${cause}`,
    );
  }
}

/** Test support: replace ctx.reserved_boundary_on() (migrator-owned) by a constant. The migrations always create it ON. */
export async function setReservedBoundary(migratorUrl: string, on: boolean): Promise<void> {
  const pool = new pg.Pool({ connectionString: migratorUrl, max: 1 });
  try {
    await pool.query(
      on
        ? `CREATE OR REPLACE FUNCTION ctx.reserved_boundary_on() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT true $$`
        : `CREATE OR REPLACE FUNCTION ctx.reserved_boundary_on() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT false $$`,
    );
  } finally {
    await pool.end();
  }
}
