// Dev helper: prints the DDL Better Auth expects for our options, against an empty scratch database.
// Used to write db/migrations/0004_auth.sql by hand (reviewed), never applied directly.
//   node --import ./scripts/register-ts-paths.mjs scripts/print-auth-ddl.ts
import { existsSync } from 'node:fs';
import { getMigrations } from 'better-auth/db/migration';
import pg from 'pg';
import { loadEnv } from '@/lib/env';
import { baseAuthOptions } from '@/modules/platform-security/auth/options';
import { ensureDatabase, superuserUrl } from './db-bootstrap';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const env = loadEnv(process.env);
const scratch = 'belgobeton_ddl_scratch';
const admin = new pg.Client({ connectionString: superuserUrl(env, 'postgres') });
await admin.connect();
await admin.query(`drop database if exists ${scratch} with (force)`);
await admin.end();
await ensureDatabase(env, scratch);

const url = new URL(env.DATABASE_URL_MIGRATOR);
url.pathname = `/${scratch}`;
const pool = new pg.Pool({ connectionString: url.toString() });
const { compileMigrations } = await getMigrations(baseAuthOptions({ authPool: pool, env }));
console.log(await compileMigrations());
await pool.end();
