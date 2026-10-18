// Encrypted backup + audit anchor (AC-SEC-12, CP2).
//   corepack pnpm backup     → backups/<timestamp>.sql.age and backups/<timestamp>.audit-anchor.json
// Copy both off this host. The age private key is never stored on the app host.
import { existsSync } from 'node:fs';
import { loadEnv } from '@/lib/env';
import { createBackup } from './backup-lib';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const env = loadEnv(process.env);
const { backupFile, anchorFile, anchor } = await createBackup({
  backupUrl: env.DATABASE_URL_BACKUP,
  recipient: env.BACKUP_AGE_RECIPIENT,
  dir: 'backups',
});
console.log(`Backup:  ${backupFile}`);
console.log(`Anchor:  ${anchorFile} (audit event ${anchor.lastEventId ?? 'none'})`);
