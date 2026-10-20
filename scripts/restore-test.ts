// Restores a backup into a scratch database and checks it (AC-SEC-12, CP2 anchor).
//   corepack pnpm backup:restore-test [backups/<timestamp>.sql.age]   (default: the latest backup)
// Needs BACKUP_AGE_IDENTITY_FILE (path to the age private key) and the local superuser password.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { loadEnv } from '@/lib/env';
import { recordRestoreTest } from '@/modules/platform-security/service/checklist';
import { restoreCheck } from './backup-lib';
import { superuserUrl } from './db-bootstrap';
import { handleHelp } from './cli-help';

handleHelp(import.meta.url);

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
// Ops secrets (superuser, backup role, age identity) live in .env.ops, which Next.js never loads.
if (existsSync('.env.ops')) process.loadEnvFile('.env.ops');
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
// Automated evidence for the security checklist (restore test < 7 days).
const systemPool = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
try {
  const failed = report.checks.find((c) => !c.ok);
  await recordRestoreTest(systemPool, { ok: report.ok, detail: failed ? failed.name : backupFile });
} finally {
  await systemPool.end();
}
if (!report.ok) process.exitCode = 1;
