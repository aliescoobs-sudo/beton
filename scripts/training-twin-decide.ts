// T11b: the decisions for the fictitious twin on the TRAINING instance, taken through the same service functions as the History screens
// (so they are audited and bound to the account). The twin is synthetic, so the "right answers" are known:
//   - clients: the busiest labels (>= 16 uses) become new client records, the rest keep their label only;
//   - trucks: unknown (no new truck enters the planning); drivers: label only;
//   - BB25 and B25HYD are the B25 mix; B26 and B27 stay unknown; the pump label "P SITRAD" is a pump;
//   - expense categories: REPARATION and ENTRETIEN are parts, DIVERS is other;
//   - every quarantined row is discarded (the twin's bad rows are on purpose).
// Refuses unless TRAINING_MODE=true. Only labels still pending are decided; run it again after a new --stage.
//   OPS_TWIN_DIR=... ./scripts/training/ops.sh training-twin-decide --account <app_admin or owner email>
import pg from 'pg';
import { loadEnv } from '../src/lib/env.ts';
import { realClock } from '../src/modules/clock/index.ts';
import { decideLabel, decideQuarantine, listLabels, listQuarantine } from '../src/modules/importer/index.ts';
import { handleHelp } from './cli-help';
import { findImportAccount } from './import-excel-lib';

handleHelp(import.meta.url);

const env = loadEnv(process.env);
if (!env.TRAINING_MODE || env.REAL_DATA) {
  console.error('training-twin-decide: refused (training mode only, never real data).');
  process.exit(1);
}
const at = process.argv.indexOf('--account');
const email = at >= 0 ? process.argv[at + 1] : undefined;
if (!email) {
  console.error('usage: training-twin-decide --account <email>');
  process.exit(2);
}
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
  const TYPES: Record<string, string | null> = { BB25: 'B25', B25HYD: 'B25' };
  const CATS: Record<string, string> = {
    'REPARATION FICTIF': 'parts',
    'ENTRETIEN FICTIF': 'parts',
    'DIVERS FICTIF': 'other',
  };
  const done: Record<string, number> = {};
  const bump = (k: string) => (done[k] = (done[k] ?? 0) + 1);
  for (const kind of ['client', 'truck', 'driver', 'type', 'pump', 'category'] as const) {
    const { labels } = await listLabels(appPool, actor as never, { kind, onlyOpen: true });
    for (const l of labels) {
      let input: Record<string, unknown>;
      if (kind === 'client') input = { kind, key: l.key, status: l.uses >= 16 ? 'new' : 'label_only' };
      else if (kind === 'truck') input = { kind, key: l.key, status: 'unknown' };
      else if (kind === 'driver') input = { kind, key: l.key, status: 'label_only' };
      else if (kind === 'type')
        input = TYPES[l.key]
          ? { kind, key: l.key, status: 'mapped', canonical: TYPES[l.key] }
          : { kind, key: l.key, status: 'unknown' };
      else if (kind === 'pump')
        input =
          l.key === 'P SITRAD'
            ? { kind, key: l.key, status: 'mapped', canonical: 'pump' }
            : { kind, key: l.key, status: 'unknown' };
      else
        input = CATS[l.key]
          ? { kind, key: l.key, status: 'mapped', canonical: CATS[l.key] }
          : { kind, key: l.key, status: 'unknown' };
      const r = await decideLabel(appPool, actor as never, input);
      if (!r.ok) throw new Error(`decision refused for a ${kind} label: ${r.error}`);
      bump(`${kind}:${String(input.status)}`);
    }
  }
  for (const q of await listQuarantine(appPool, actor as never, { onlyOpen: true })) {
    const r = await decideQuarantine(appPool, actor as never, { id: q.id, action: 'discard' });
    if (!r.ok) throw new Error(`quarantine decision refused: ${r.error}`);
    bump('quarantine:discard');
  }
  console.log(`decided at ${realClock.now().toISOString()}:`, JSON.stringify(done));
} catch (e) {
  console.error(e instanceof Error ? e.message : 'failed');
  process.exitCode = 1;
} finally {
  await Promise.all([appPool.end(), authPool.end()]);
}
