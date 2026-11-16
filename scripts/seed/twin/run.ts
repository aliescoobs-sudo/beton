// The twin seed on a fictitious database (D251). See docs/TWIN-SEED.md.
//   TWIN_SEED_FICTITIOUS=true corepack pnpm seed:twin
// Needs the training seed first (TRAINING_SEED_PROFILE=twin-base). Refuses on a production-looking environment and without the fictitious marker.
import { existsSync } from 'node:fs';
import { handleHelp } from '../../cli-help';

if (import.meta.main) {
  handleHelp(import.meta.url);
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  if (existsSync('.env.ops')) process.loadEnvFile('.env.ops');
  const { loadMaintenanceEnv, loadSeedUrl } = await import('../../../src/lib/env.ts');
  const { seedTwin } = await import('./index.ts');
  try {
    const env = { ...loadMaintenanceEnv(process.env), DATABASE_URL_SEED: loadSeedUrl(process.env) };
    const r = await seedTwin({ env, flag: process.env.TWIN_SEED_FICTITIOUS });
    console.log(r.applied ? 'Twin seeded.' : 'The twin is already in place (nothing changed).');
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
