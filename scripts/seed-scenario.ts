// The pilot scenario (fake data only, decision 79): a mid-size Tetouan plant three months into its activity, with
// orders, cheques and LCN in every state, instalments, supplier payments and one tight cash day, dated relative to
// today (the simulation clock when it is running, else the real date). Run `corepack pnpm db:seed` first.
// Needs SIMULATION_ENABLED=true; refuses with REAL_DATA=true or NODE_ENV=production. Idempotent: does nothing twice.
//   corepack pnpm db:scenario
import { existsSync } from 'node:fs';
import pg from 'pg';
import { loadSeedUrl } from '../src/lib/env.ts';
import { seedPilotScenario } from '../src/modules/ledger/service/pilot-scenario.ts';
import { seedOperationsScenario } from '../src/modules/operations/service/pilot-ops.ts';
import { seedIntegrationScenario } from '../src/modules/operations/service/pilot-integration.ts';
import { seedOperationsWave2 } from '../src/modules/operations/service/pilot-ops2.ts';
import { handleHelp } from './cli-help';

if (import.meta.main) {
  handleHelp(import.meta.url);
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  if (existsSync('.env.ops')) process.loadEnvFile('.env.ops');
  const { loadEnv } = await import('../src/lib/env.ts');
  const { businessDateOf, readSimNow, realClock } = await import('../src/modules/clock/index.ts');
  const { SYSTEM_ACTOR_ID } = await import('../src/modules/platform-security/auth/actors.ts');
  const env = loadEnv(process.env);

  // "Today" is the simulated day when the simulated clock has been started, else the real day.
  let now = realClock.now();
  if (env.SIMULATION_ENABLED) {
    const systemPool = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
    try {
      now = await readSimNow(systemPool, true, { userId: SYSTEM_ACTOR_ID, role: 'system' });
    } catch {
      // not initialised yet: the real date
    } finally {
      await systemPool.end();
    }
  }
  const pool = new pg.Pool({ connectionString: loadSeedUrl(process.env), max: 1 });
  try {
    const today = businessDateOf(now);
    const result = await seedPilotScenario(pool, env, today);
    console.log(
      result.applied
        ? `Pilot scenario seeded: ${result.orders} orders, ${result.instruments} payments, opening ${result.openingDate}, today ${result.today}`
        : 'Pilot scenario already in place (nothing changed)',
    );
    // The operations part (loads, stock, purchases, invoices) has its own idempotence: it also completes a scenario that was
    // seeded before it existed.
    const ops = await seedOperationsScenario(pool, env, today);
    console.log(
      ops.applied
        ? `Operations scenario seeded: ${ops.loads} loads (${ops.returns} signed BL back), ${ops.purchases} purchases (${ops.receipts} received), ${ops.invoices} invoices, today ${today}`
        : 'Operations scenario already in place (nothing changed)',
    );
    // The second wave (SPEC-operations §7): drivers, rotations and their tracking, counts, fuel, refused loads.
    const wave2 = await seedOperationsWave2(pool, env, today);
    console.log(
      wave2.applied
        ? `Operations wave 2 seeded: ${wave2.drivers} drivers, ${wave2.rotations} rotations (${wave2.events} steps), ${wave2.plannedAhead} planned ahead, ${wave2.counts} counts, ${wave2.fills} fuel fills, ${wave2.fuelPurchases} fuel purchases, ${wave2.losses} refused loads`
        : 'Operations wave 2 already in place (nothing changed)',
    );
    // The integration walk (CP-INTEGRATION-2): the sales chain from rotation to bounced cheque, the purchase chain from a
    // partial receipt to a paid supplier invoice that carried gaps.
    const integration = await seedIntegrationScenario(pool, env, today);
    console.log(
      integration.applied
        ? `Integration walk seeded: ${integration.loads} loads, ${integration.invoices} invoices from BLs, ${integration.payments} payments (one bounced), ${integration.supplierInvoices} supplier invoice approved and paid`
        : 'Integration walk already in place (nothing changed)',
    );
  } finally {
    await pool.end();
  }
}
