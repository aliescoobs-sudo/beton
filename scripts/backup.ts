// One backup set: the database AND the stored documents, sealed with the age public key (AC-SEC-12, C2).
//   corepack pnpm backup  (on a server: scripts/ops/backup-nightly.sh)
// Writes backups/<stamp>.sql.age, <stamp>.files.tar.age and, last, <stamp>.audit-anchor.json (the manifest). A set without its
// manifest is incomplete. Needs only DATABASE_URL_BACKUP, BACKUP_AGE_RECIPIENT and FILE_STORE_DIR: nothing else of the app's secrets.
// Copy the set off this host (the office machine pulls it). The age private key is never stored on the app host.
import { existsSync } from 'node:fs';
import { loadBackupUrl } from '@/lib/env';
import { createBackup } from './backup-lib';
import { handleHelp } from './cli-help';

handleHelp(import.meta.url);

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
// Ops secrets (superuser, backup role, age identity) live in .env.ops, which Next.js never loads.
if (existsSync('.env.ops')) process.loadEnvFile('.env.ops');
const recipient = process.env.BACKUP_AGE_RECIPIENT ?? '';
if (!recipient.startsWith('age1')) {
  console.error('BACKUP_AGE_RECIPIENT must be an age public key (age1…)');
  process.exit(1);
}
const { manifestFile, manifest } = await createBackup({
  backupUrl: loadBackupUrl(process.env), // backup job only, never in the app environment
  recipient,
  dir: 'backups',
  fileStoreDir: process.env.FILE_STORE_DIR ?? 'file-store',
});
console.log(`Backup set: ${manifestFile}`);
console.log(
  `Database ${manifest.artifacts.database.bytes} bytes, documents ${manifest.fileCount} (${manifest.artifacts.files.bytes} bytes)`,
);
console.log(`Audit anchor: event ${manifest.lastEventId ?? 'none'}`);
