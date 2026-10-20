// Dev helper: prints the DDL Better Auth expects for our options, against an empty scratch database.
// Used to write db/migrations/0004_auth.sql by hand (reviewed), never applied directly.
//   node --import ./scripts/register-ts-paths.mjs scripts/print-auth-ddl.ts
import { existsSync } from 'node:fs';
import { getMigrations } from 'better-auth/db/migration';
import pg from 'pg';
import { loadEnv } from '@/lib/env';
import { baseAuthOptions } from '@/modules/platform-security/auth/options';
import { DDL_SCRATCH_DATABASE, recreateDatabase } from './db-bootstrap';
import { handleHelp } from './cli-help';

handleHelp(import.meta.url);

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const env = loadEnv(process.env);
const scratch = DDL_SCRATCH_DATABASE;
await recreateDatabase(env, scratch);

const url = new URL(env.DATABASE_URL_MIGRATOR);
url.pathname = `/${scratch}`;
const pool = new pg.Pool({ connectionString: url.toString() });
const { compileMigrations } = await getMigrations(baseAuthOptions({ authPool: pool, env }));
console.log(await compileMigrations());
await pool.end();
