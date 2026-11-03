// Restores a backup set into a scratch database and directory and checks it (AC-SEC-12, C2). Run on the OFFICE machine.
//   corepack pnpm backup:restore-test [backups/<stamp>.audit-anchor.json] [--record] [--allow-unsigned]   (default: the latest set)
// Needs: BACKUP_AGE_IDENTITY_FILE (age private key), BACKUP_SIGNING_PUBLIC_KEY_FILE (checks the office signature of the set),
// FIELD_ENCRYPTION_KEYS (from the key escrow: opens the stored documents) and a local superuser login for the scratch database.
// Writes <stamp>.restore-report.json (+ .sig when BACKUP_SIGNING_KEY_FILE is set): copy both to the server and run
// `checklist:record-restore` there; the office machine has no route to the production database. --record writes the evidence
// straight into the database of this environment instead (development). --allow-unsigned skips the signature (development only).
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { loadMaintenanceEnv } from '@/lib/env';
import { realClock } from '@/modules/clock';
import { recordRestoreTest } from '@/modules/platform-security/service/checklist';
import { MANIFEST_SUFFIX, restoreCheck, signText } from './backup-lib';
import { superuserUrl } from './db-bootstrap';
import { handleHelp } from './cli-help';

handleHelp(import.meta.url);

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
// Ops secrets (superuser, backup role, age identity) live in .env.ops, which Next.js never loads.
if (existsSync('.env.ops')) process.loadEnvFile('.env.ops');
const env = loadMaintenanceEnv(process.env);
const identityFile = process.env.BACKUP_AGE_IDENTITY_FILE;
if (!identityFile || !existsSync(identityFile)) {
  console.error('Set BACKUP_AGE_IDENTITY_FILE to the path of the age private key (kept off the app host).');
  process.exit(1);
}
const args = process.argv.slice(2);
const allowUnsigned = args.includes('--allow-unsigned');
const publicKeyFile = process.env.BACKUP_SIGNING_PUBLIC_KEY_FILE;

const manifestFile =
  args.find((a) => !a.startsWith('--')) ??
  join(
    'backups',
    readdirSync('backups')
      .filter((f) => f.endsWith(MANIFEST_SUFFIX))
      .sort()
      .at(-1) ?? '',
  );
if (!existsSync(manifestFile)) {
  console.error(`Backup manifest not found: ${manifestFile}`);
  process.exit(1);
}

const report = await restoreCheck({
  manifestFile,
  identityFile,
  ...(publicKeyFile ? { publicKeyFile } : {}),
  allowUnsigned,
  ...(process.env.FIELD_ENCRYPTION_KEYS ? { fieldKeys: process.env.FIELD_ENCRYPTION_KEYS } : {}),
  adminUrl: superuserUrl(env, 'postgres'),
});
for (const check of report.checks)
  console.log(`${check.ok ? 'OK  ' : 'FAIL'} ${check.name}${check.detail ? ` (${check.detail})` : ''}`);
console.log(report.ok ? `Restore test passed: ${manifestFile}` : `Restore test FAILED: ${manifestFile}`);

// The evidence for the security checklist (restore test < 35 days): a report the office signs, recorded on the server.
const base = manifestFile.slice(0, -MANIFEST_SUFFIX.length);
const body = `${JSON.stringify({ schema: 1, set: base.split('/').pop(), ok: report.ok, at: realClock.now().toISOString(), failed: report.checks.find((c) => !c.ok)?.name ?? null }, null, 2)}\n`;
writeFileSync(`${base}.restore-report.json`, body, { mode: 0o600 });
if (process.env.BACKUP_SIGNING_KEY_FILE && existsSync(process.env.BACKUP_SIGNING_KEY_FILE)) {
  writeFileSync(`${base}.restore-report.sig`, signText(body, process.env.BACKUP_SIGNING_KEY_FILE), {
    mode: 0o600,
  });
  console.log(
    `Signed report: ${base}.restore-report.json (+ .sig) — copy both to the server and run checklist:record-restore.`,
  );
} else {
  console.log('No BACKUP_SIGNING_KEY_FILE: the report is unsigned and the server will not accept it.');
}
if (args.includes('--record')) {
  const systemPool = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
  try {
    const failed = report.checks.find((c) => !c.ok);
    await recordRestoreTest(systemPool, { ok: report.ok, detail: failed ? failed.name : manifestFile });
  } finally {
    await systemPool.end();
  }
}
if (!report.ok) process.exitCode = 1;
