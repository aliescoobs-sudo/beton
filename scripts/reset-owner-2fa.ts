// Owner break-glass (DECISIONS 75): resets the owner's 2FA when both the authenticator and the recovery codes are
// lost. Runs on the server only; needs the database superuser password; audited; alerts the owner and the partner.
//   corepack pnpm user:reset-owner-2fa
import { existsSync } from 'node:fs';
import pg from 'pg';
import { loadMaintenanceEnv } from '@/lib/env';
import { resetOwnerTwoFactor } from '@/modules/platform-security/service/break-glass';
import { createPrompt } from './prompt';
import { handleHelp } from './cli-help';

handleHelp(import.meta.url);

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const env = loadMaintenanceEnv(process.env);
const prompt = createPrompt();
const authPool = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 1 });
const systemPool = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });

try {
  console.log("This removes the owner's authenticator and recovery codes and ends the owner's sessions.");
  console.log('The owner and the partner will see a security alert. The action is audited.');
  if ((await prompt.ask('Type RESET to continue: ')) !== 'RESET') throw new Error('Cancelled');
  const password = await prompt.secret('Database superuser password: ');

  const adminUrl = new URL(env.DATABASE_URL_MIGRATOR);
  adminUrl.username = 'postgres';
  adminUrl.password = password;
  adminUrl.pathname = '/postgres';

  await resetOwnerTwoFactor({ adminUrl: adminUrl.toString(), authPool, systemPool });
  console.log('Owner 2FA reset. At next login the owner sets up a new authenticator.');
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  prompt.close();
  await Promise.all([authPool.end(), systemPool.end()]);
}
