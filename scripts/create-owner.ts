// Creates the single owner account (no seed or default accounts exist). Refuses if an owner exists.
// The owner must enrol an authenticator app (2FA) at first login.
//   corepack pnpm user:create-owner
import { existsSync } from 'node:fs';
import pg from 'pg';
import { loadEnv } from '@/lib/env';
import { BOOTSTRAP_ACTOR_ID, createAuth, createUser } from '@/modules/platform-security';
import { createPrompt } from './prompt';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const env = loadEnv(process.env);

const prompt = createPrompt();
const ask = prompt.ask;
const readSecret = prompt.secret;

try {
  const email = await ask('Owner email: ');
  const name = await ask('Display name: ');
  const locale = ((await ask('Language (fr/ar) [fr]: ')) || 'fr') as 'fr' | 'ar';
  if (locale !== 'fr' && locale !== 'ar') throw new Error('Language must be fr or ar');
  const password = await readSecret('Password (min 12 characters): ');
  if ((await readSecret('Repeat password: ')) !== password) throw new Error('Passwords do not match');

  const authPool = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 2 });
  try {
    const auth = createAuth({ authPool, env });
    await createUser(auth, authPool, {
      actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' },
      email,
      name,
      password,
      role: 'owner',
      locale,
    });
    console.log('Owner created. At first login you will set up an authenticator app (2FA).');
  } finally {
    prompt.close();
    await authPool.end();
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
