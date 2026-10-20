// Inserts the pilot master data (components, purchase units, concrete types) as the system actor, audited.
// Needs SIMULATION_ENABLED=true; refuses with REAL_DATA=true or NODE_ENV=production. Idempotent.
//   corepack pnpm db:seed
import { existsSync } from 'node:fs';
import pg from 'pg';
import { seedPilotMasterData } from '../src/modules/master-data/service/pilot-seed.ts';
import { handleHelp } from './cli-help';

if (import.meta.main) {
  handleHelp(import.meta.url);
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  const { loadEnv } = await import('../src/lib/env.ts');
  const env = loadEnv(process.env);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
  try {
    await seedPilotMasterData(pool, env);
    console.log('Pilot master data seeded');
  } finally {
    await pool.end();
  }
}
