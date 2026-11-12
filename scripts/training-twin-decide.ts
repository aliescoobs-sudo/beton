// T11b: the decisions for the fictitious twin on the TRAINING instance, taken through the same service functions as the History screens
// (so they are audited and bound to the account). The twin is synthetic, so the "right answers" are known:
//   - clients: the busiest labels (>= 16 uses) become new client records, the rest keep their label only;
//   - trucks: unknown (no new truck enters the planning); drivers: label only;
//   - BB25 and B25HYD are the B25 mix; B26 and B27 stay unknown; the pump label "P SITRAD" is a pump;
//   - expense categories: REPARATION and ENTRETIEN are parts, DIVERS is other;
//   - every quarantined row OF THE NAMED SET is discarded (the twin's bad rows are on purpose).
// Refuses unless TRAINING_MODE=true. T10g (R19B-12): the SET is explicit. Without --apply it only PREVIEWS the counts; it refuses while another staged set has
// pending work (labels are global), unless --quarantine-only, which touches the named set's quarantined rows and nothing else. Run it again after a new --stage.
//   OPS_TWIN_DIR=... ./scripts/training/ops.sh training-twin-decide --account <app_admin or owner email> --set <64-hex set sha> [--apply] [--quarantine-only]
import pg from 'pg';
import { loadEnv } from '../src/lib/env.ts';
import { realClock } from '../src/modules/clock/index.ts';
import { handleHelp } from './cli-help';
import { findImportAccount } from './import-excel-lib';
import { decideTwinScope } from './training-twin-lib';

handleHelp(import.meta.url);

const env = loadEnv(process.env);
if (!env.TRAINING_MODE || env.REAL_DATA) {
  console.error('training-twin-decide: refused (training mode only, never real data).');
  process.exit(1);
}
const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const email = flag('--account');
const setSha = flag('--set');
if (!email || !setSha) {
  console.error(
    'usage: training-twin-decide --account <email> --set <64-hex set sha> [--apply] [--quarantine-only]',
  );
  process.exit(2);
}
const apply = process.argv.includes('--apply');
const quarantineOnly = process.argv.includes('--quarantine-only');
const appPool = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const authPool = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 1 });
try {
  const account = await findImportAccount(authPool, email);
  if (!account) throw new Error('No active owner or app_admin account with an authenticator has this email.');
  const actor = {
    ...account,
    locale: 'fr' as const,
    twoFactorEnabled: true,
    reenrolRequired: false,
    stepUpVerified: false,
  };
  const result = await decideTwinScope(appPool, actor as never, { setSha, apply, quarantineOnly });
  if (!result.ok) {
    if (result.preview)
      console.error(
        `set ${setSha.slice(0, 12)}: ${result.preview.openQuarantine} quarantined rows, ${result.preview.stagedBatches} staged batches; pending labels (global): ${result.preview.pendingLabels}; other sets with pending work: ${result.preview.otherSets.map((o) => `${o.setSha.slice(0, 12)} (${o.openQuarantine} rows, ${o.stagedBatches} batches)`).join(', ')}`,
      );
    console.error(`training-twin-decide: refused: ${result.reason}`);
    process.exitCode = 1;
  } else {
    const p = result.preview;
    console.log(
      `set ${setSha.slice(0, 12)}: ${p.openQuarantine} quarantined rows, ${p.stagedBatches} staged batches, ${p.pendingLabels} pending labels${quarantineOnly ? ' (labels untouched: --quarantine-only)' : ''}`,
    );
    if (!result.applied) console.log('PREVIEW only: nothing was written. Add --apply to decide.');
    else console.log(`decided at ${realClock.now().toISOString()}:`, JSON.stringify(result.done));
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : 'failed');
  process.exitCode = 1;
} finally {
  await Promise.all([appPool.end(), authPool.end()]);
}
