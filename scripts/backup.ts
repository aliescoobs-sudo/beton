// Encrypted backup + audit anchor (AC-SEC-12, CP2).
//   corepack pnpm backup     → backups/<timestamp>.sql.age and backups/<timestamp>.audit-anchor.json
// Copy both off this host. The age private key is never stored on the app host.
import { existsSync } from 'node:fs';
import { loadBackupUrl, loadEnv } from '@/lib/env';
import { createBackup } from './backup-lib';
import { handleHelp } from './cli-help';

handleHelp(import.meta.url);

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
// Ops secrets (superuser, backup role, age identity) live in .env.ops, which Next.js never loads.
if (existsSync('.env.ops')) process.loadEnvFile('.env.ops');
const env = loadEnv(process.env);
const { backupFile, anchorFile, anchor } = await createBackup({
  backupUrl: loadBackupUrl(process.env), // backup job only, never in the app environment
  recipient: env.BACKUP_AGE_RECIPIENT,
  dir: 'backups',
});
console.log(`Backup:  ${backupFile}`);
console.log(`Anchor:  ${anchorFile} (audit event ${anchor.lastEventId ?? 'none'})`);
