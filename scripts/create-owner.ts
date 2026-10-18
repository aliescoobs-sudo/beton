// Creates the single owner account (no seed or default accounts exist). Refuses if an owner exists.
// The owner must enrol an authenticator app (2FA) at first login.
//   corepack pnpm user:create-owner
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import pg from 'pg';
import { loadEnv } from '@/lib/env';
import { BOOTSTRAP_ACTOR_ID, createAuth, createUser } from '@/modules/platform-security';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const env = loadEnv(process.env);

/** Reads a line without echoing it when stdin is a terminal (piped input is read as-is). */
async function readSecret(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  if (!process.stdin.isTTY) return (await lines.next()).value ?? '';
  return new Promise((resolve) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (char === '\u0003') process.exit(130); // Ctrl-C
        value = char === '\u007f' ? value.slice(0, -1) : value + char;
      }
    };
    process.stdin.on('data', onData);
  });
}

const rl = createInterface({ input: process.stdin, terminal: false });
const lines = rl[Symbol.asyncIterator]();
const ask = async (prompt: string) => {
  process.stdout.write(prompt);
  return ((await lines.next()).value ?? '').trim();
};

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
    rl.close();
    await authPool.end();
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
