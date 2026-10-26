// Empties the sealed question and answer of the assistant's interactions older than 90 days (SPEC-assistant §9). The rows, the
// keyed question hashes, the tool calls and the audit chain stay. Idempotent: run it daily.
//   corepack pnpm assistant:purge
import { existsSync } from 'node:fs';
import pg from 'pg';
import { loadEnv } from '../src/lib/env.ts';
import { PAYLOAD_RETENTION_DAYS, purgePayloads } from '../src/modules/assistant/service/purge.ts';
import { handleHelp } from './cli-help';

handleHelp(import.meta.url);

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const pool = new pg.Pool({ connectionString: loadEnv(process.env).DATABASE_URL_SYSTEM, max: 1 });
try {
  const { purged } = await purgePayloads(pool);
  console.log(`Assistant payloads emptied: ${purged} (retention ${PAYLOAD_RETENTION_DAYS} days)`);
} finally {
  await pool.end();
}
