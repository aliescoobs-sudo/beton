// Records an office restore test as security-checklist evidence (C2). Run on the SERVER, in the ops container.
//   node scripts/checklist-record-restore.ts <stamp>.restore-report.json
// The report and its .sig come from `backup:restore-test` on the office machine; the signature is checked with
// BACKUP_SIGNING_PUBLIC_KEY_FILE (the public key only), the report must be recent and must not be a failure that is hidden.
// This is the only path by which a restore test performed off the server reaches the production database.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { loadEnv } from '@/lib/env';
import { realClock } from '@/modules/clock';
import { recordRestoreTest } from '@/modules/platform-security/service/checklist';
import { verifyText } from './backup-lib';
import { handleHelp } from './cli-help';

handleHelp(import.meta.url);

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
const publicKeyFile = process.env.BACKUP_SIGNING_PUBLIC_KEY_FILE;
if (!file || !publicKeyFile) {
  console.error('Usage: checklist-record-restore.ts <report.json> (with BACKUP_SIGNING_PUBLIC_KEY_FILE set)');
  process.exit(2);
}
function readOrExplain(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    console.error(
      code === 'EACCES'
        ? `${path} cannot be read by the container: on the host run  chmod 640 reports/*  (group 10001 reads, see the runbook).`
        : `${path} cannot be read (${code ?? 'error'}): upload the report and its .sig to reports/ first.`,
    );
    process.exit(1);
  }
}
const body = readOrExplain(file);
const signature = readOrExplain(file.replace(/\.json$/, '.sig'));
if (!verifyText(body, signature, publicKeyFile)) {
  console.error('The report signature is invalid: nothing recorded.');
  process.exit(1);
}
const report = JSON.parse(body) as { ok: boolean; at: string; set: string; failed: string | null };
if (realClock.now().getTime() - Date.parse(report.at) > 36 * 3_600_000) {
  console.error('The report is older than 36 hours: run the restore test again.');
  process.exit(1);
}
const env = loadEnv(process.env);
const systemPool = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
try {
  await recordRestoreTest(systemPool, {
    ok: report.ok,
    detail: report.ok ? report.set : (report.failed ?? report.set),
  });
} finally {
  await systemPool.end();
}
console.log(
  `Recorded: restore test of ${report.set} ${report.ok ? 'passed' : 'FAILED'} (signed by the office).`,
);
