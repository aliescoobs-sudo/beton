import pg from 'pg';
import { getEnv } from '../server-env';

export type PoolRole = 'app' | 'auth' | 'system';

const URL_OF = {
  app: 'DATABASE_URL_APP',
  auth: 'DATABASE_URL_AUTH',
  system: 'DATABASE_URL_SYSTEM',
} as const;

const pools = new Map<PoolRole, pg.Pool>();

/** One lazily created pool per runtime database role (the migrator never runs inside the app). */
export function getPool(role: PoolRole): pg.Pool {
  let pool = pools.get(role);
  if (!pool) {
    pool = new pg.Pool({ connectionString: getEnv()[URL_OF[role]], max: 10 });
    pools.set(role, pool);
  }
  return pool;
}
