import { existsSync } from 'node:fs';
import { TEST_DATABASE } from '../scripts/db-bootstrap';
import { loadBackupUrl, loadEnv } from '../src/lib/env';

/** Integration tests run against `belgobeton_test`, with the same roles as dev (see scripts/db-bootstrap.ts). */
export function testEnv(database: string = TEST_DATABASE) {
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  const env = loadEnv(process.env);
  const toTestDb = (url: string) => {
    const u = new URL(url);
    u.pathname = `/${database}`;
    return u.toString();
  };
  return {
    ...env,
    DATABASE_URL_APP: toTestDb(env.DATABASE_URL_APP),
    DATABASE_URL_MIGRATOR: toTestDb(env.DATABASE_URL_MIGRATOR),
    DATABASE_URL_AUTH: toTestDb(env.DATABASE_URL_AUTH),
    DATABASE_URL_SYSTEM: toTestDb(env.DATABASE_URL_SYSTEM),
    DATABASE_URL_BACKUP: toTestDb(loadBackupUrl(process.env)),
  };
}
