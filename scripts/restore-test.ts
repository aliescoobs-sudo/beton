// Restores a backup into a scratch database and checks it (AC-SEC-12, CP2 anchor).
//   corepack pnpm backup:restore-test [backups/<timestamp>.sql.age]   (default: the latest backup)
// Needs BACKUP_AGE_IDENTITY_FILE (path to the age private key) and the local superuser password.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '@/lib/env';
import { restoreCheck } from './backup-lib';
import { superuserUrl } from './db-bootstrap';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const env = loadEnv(process.env);
const identityFile = process.env.BACKUP_AGE_IDENTITY_FILE;
if (!identityFile || !existsSync(identityFile)) {
  console.error('Set BACKUP_AGE_IDENTITY_FILE to the path of the age private key (kept off the app host).');
  process.exit(1);
}

const backupFile =
  process.argv[2] ??
  join(
    'backups',
    readdirSync('backups')
      .filter((f) => f.endsWith('.sql.age'))
      .sort()
      .at(-1) ?? '',
  );
const anchorFile = backupFile.replace(/\.sql\.age$/, '.audit-anchor.json');
if (!existsSync(backupFile) || !existsSync(anchorFile)) {
  console.error(`Backup or anchor not found: ${backupFile}`);
  process.exit(1);
}

const report = await restoreCheck({
  backupFile,
  anchorFile,
  identityFile,
  adminUrl: superuserUrl(env, 'postgres'),
});
for (const check of report.checks)
  console.log(`${check.ok ? 'OK  ' : 'FAIL'} ${check.name}${check.detail ? ` (${check.detail})` : ''}`);
console.log(report.ok ? `Restore test passed: ${backupFile}` : `Restore test FAILED: ${backupFile}`);
if (!report.ok) process.exitCode = 1;
