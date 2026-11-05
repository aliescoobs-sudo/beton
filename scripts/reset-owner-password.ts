// Owner break-glass: sets a new password for the owner when it is forgotten (the authenticator is still needed to sign in).
// Runs on the server only; needs the database superuser password; the new password is typed at a hidden prompt, never printed
// or logged; audited as `password_reset`; the owner's sessions end.
//   corepack pnpm user:reset-owner-password
import { existsSync } from 'node:fs';
import pg from 'pg';
import { loadMaintenanceEnv } from '@/lib/env';
import { resetOwnerPassword } from '@/modules/platform-security/service/break-glass';
import { createPrompt } from './prompt';
import { handleHelp } from './cli-help';

handleHelp(import.meta.url);

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const env = loadMaintenanceEnv(process.env);
const prompt = createPrompt();
const authPool = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 1 });
const systemPool = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });

try {
  console.log("This sets a new password for the owner and ends the owner's sessions. The action is audited.");
  if ((await prompt.ask('Type RESET to continue: ')) !== 'RESET') throw new Error('Cancelled');
  const password = await prompt.secret('Database superuser password: ');
  const next = await prompt.secret('New owner password (12 characters or more): ');
  if (next !== (await prompt.secret('Type it again: '))) throw new Error('The two entries differ');

  const adminUrl = new URL(env.DATABASE_URL_MIGRATOR);
  adminUrl.username = 'postgres';
  adminUrl.password = password;
  adminUrl.pathname = '/postgres';

  await resetOwnerPassword({ adminUrl: adminUrl.toString(), authPool, systemPool }, next);
  console.log('Owner password reset. The owner signs in with the new password and the same authenticator.');
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  prompt.close();
  await Promise.all([authPool.end(), systemPool.end()]);
}
