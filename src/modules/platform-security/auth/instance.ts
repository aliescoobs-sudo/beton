import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { type Auth, createAuth } from './create-auth';

let instance: Auth | undefined;

/** The app's Better Auth instance, on the belgobeton_auth pool. */
export function getAuth(): Auth {
  instance ??= createAuth({ authPool: getPool('auth'), env: getEnv() });
  return instance;
}
