// Inserts the pilot master data (zones, clients, suppliers, components, recettes, prices, trucks...) through the belgobeton_seed role (request context: the system actor), audited.
// Needs SIMULATION_ENABLED=true; refuses with REAL_DATA=true or NODE_ENV=production. Idempotent.
//   corepack pnpm db:seed
import { existsSync } from 'node:fs';
import pg from 'pg';
import { loadSeedUrl } from '../src/lib/env.ts';
import { seedPilotMasterData } from '../src/modules/master-data/service/pilot-seed.ts';
import { handleHelp } from './cli-help';

if (import.meta.main) {
  handleHelp(import.meta.url);
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  // The seed's own role (DATABASE_URL_SEED) lives in .env.ops, which Next.js never loads.
  if (existsSync('.env.ops')) process.loadEnvFile('.env.ops');
  const { loadEnv } = await import('../src/lib/env.ts');
  const env = loadEnv(process.env);
  const pool = new pg.Pool({ connectionString: loadSeedUrl(process.env), max: 1 });
  try {
    await seedPilotMasterData(pool, env);
    console.log('Pilot master data seeded');
  } finally {
    await pool.end();
  }
}
