// Re-arms the training day (T5): today's orders, the drivers' rotations in sequence, quotes, an order to cancel, a delivery to receive and a
// low-stock alert, dated from TODAY. Takes under a minute, keeps every account and password, and leaves whatever a trainee already started.
//   corepack pnpm rearm:training              (on the iMac: ./scripts/training-rearm.sh)
// Refused unless TRAINING_MODE=true and the database carries the training marker.
import { existsSync } from 'node:fs';
import { handleHelp } from './cli-help';

handleHelp(import.meta.url);

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
if (existsSync('.env.ops')) process.loadEnvFile('.env.ops');
const { loadMaintenanceEnv } = await import('../src/lib/env.ts');
const { businessDateOf, realClock } = await import('../src/modules/clock/index.ts');
const { armTrainingDay } = await import('./training-day.ts');
try {
  const env = loadMaintenanceEnv(process.env);
  if (!env.TRAINING_MODE || env.APP_ENV === 'production' || env.REAL_DATA)
    throw new Error('rearm:training needs TRAINING_MODE=true, APP_ENV not production and REAL_DATA off');
  const r = await armTrainingDay(env, businessDateOf(realClock.now()));
  console.log(
    `Training day ${r.date} armed: ${r.ordersCreated} orders created, ${r.ordersCancelled} unproduced orders of the day cancelled, ${r.rotationsPlanned} rotations planned. Accounts unchanged.`,
  );
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
