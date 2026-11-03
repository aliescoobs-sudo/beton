// Recomputes the audit hash chain in TypeScript and reports the first broken event.
//   corepack pnpm audit:verify
import { existsSync } from 'node:fs';
import pg from 'pg';
import { loadMaintenanceEnv } from '../src/lib/env.ts';
import { verifyAuditChain } from '../src/modules/platform-security/service/audit-chain.ts';
import { handleHelp } from './cli-help';

handleHelp(import.meta.url);

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const client = new pg.Client({ connectionString: loadMaintenanceEnv(process.env).DATABASE_URL_MIGRATOR });
await client.connect();
try {
  const verdict = await verifyAuditChain(client);
  if (verdict.ok) {
    console.log(`Audit chain OK (${verdict.checked} events)`);
  } else {
    console.error(
      `Audit chain BROKEN at event ${verdict.brokenId} (${verdict.problem} mismatch) after ${verdict.checked} valid events`,
    );
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
