// History importer (T11): the deliveries and expenses of the company's monthly Excel files, loaded as a separate, flagged layer.
//   corepack pnpm import:history --init-mapping <folder>                         (editable example mapping files, never overwritten)
//   corepack pnpm import:history --dry-run <folder> --mapping <file>              (reads and reports; writes nothing; needs the database)
//   corepack pnpm import:history --stage   <folder> --mapping <file> --account <email>   (writes the staging: labels to decide, rows in quarantine)
//   corepack pnpm import:history --apply   <folder> --mapping <file> --account <email>   (typed phrase + authenticator code; blocked while mappings are open)
//   corepack pnpm import:history --rollback <batch id> --account <email>          (typed phrase + authenticator code; marks the batch, deletes nothing)
// One folder = the monthly files of ONE plant and ONE kind (the mapping names both). Files are numbered by their sorted position; the row date
// is the truth, never the file name. History never touches live stock, invoices, the ledger, trips or dispatch (decision 211).
// Production mode: real files only (REAL_DATA=true), refuses twin files. TRAINING_MODE=true: only the fictitious twin (pnpm import:twin).
// Reports carry counts, row numbers and fixed phrases; never a cell. Saved in ./.logs/ (0600). Run mapping decisions on the History screens.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { loadEnv } from '../src/lib/env.ts';
import { withRlsContext } from '../src/lib/db/rls-context.ts';
import { uuidv7 } from '../src/lib/uuidv7.ts';
import { realClock } from '../src/modules/clock/index.ts';
import {
  assertHistoryEnvironment,
  exampleMappings,
  formatHistoryReport,
  formatHistoryRollback,
  historyConfirmation,
  historyRollbackConfirmation,
  ImportRefused,
  ImportTransactionError,
  rollbackHistory,
  runHistory,
} from '../src/modules/importer/index.ts';
import { recordAuditEvent } from '../src/modules/platform-security/index.ts';
import { handleHelp } from './cli-help';
import { findImportAccount, safeErrorLine, verifyImportCode, writePrivateReport } from './import-excel-lib';
import { listInputFiles, loadHistoryMapping, parseHistoryArgs } from './import-history-lib';
import { createPrompt } from './prompt';

handleHelp(import.meta.url);

const args = parseHistoryArgs(process.argv.slice(2));
if (args.problems.length || !args.mode || !args.target) {
  for (const p of args.problems) console.error(`import:history: ${p}`);
  console.error(
    'usage: import:history --dry-run|--stage|--apply <folder> --mapping <file> | --rollback <batch id> | --init-mapping <folder>  (see --help)',
  );
  process.exit(2);
}

if (args.mode === 'init-mapping') {
  mkdirSync(args.target, { recursive: true });
  for (const m of exampleMappings()) {
    const file = path.join(args.target, `${m.kind}-${m.plant.toLowerCase()}.json`);
    if (existsSync(file)) console.log(`kept (already there) ${file}`);
    else {
      writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`, { flag: 'wx' });
      console.log(`written ${file}`);
    }
  }
  process.exit(0);
}

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const env = loadEnv(process.env);
const environment = {
  trainingMode: env.TRAINING_MODE,
  realData: env.REAL_DATA,
  simulationEnabled: env.SIMULATION_ENABLED,
};
const logReport = (name: string, text: string) =>
  console.log(`(report saved in ${writePrivateReport('.logs', name, text, realClock.now())})`);

const appPool = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const authPool = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 1 });
const prompt = createPrompt();
try {
  let account = args.account ? await findImportAccount(authPool, args.account) : null;
  if (args.account && !account)
    throw new ImportRefused(
      'ROLE',
      'No active owner or app_admin account with an authenticator has this email.',
    );
  if (!account) {
    const owners = await authPool.query<{ email: string }>(
      `select email from "user" where role = 'owner' and status = 'active'`,
    );
    if (owners.rows.length !== 1) throw new ImportRefused('ROLE', 'Name the account with --account <email>.');
    account = await findImportAccount(authPool, owners.rows[0]!.email);
    if (!account) throw new ImportRefused('ROLE', 'The owner has no verified authenticator yet.');
  }
  const actor = { ...account, locale: 'fr' as const, twoFactorEnabled: true, reenrolRequired: false };

  // the second factor, bound to ONE operation: the same verification as the T2 importer (single use, persisted failure budget, audited)
  const stepUp = async (operation: string): Promise<boolean> => {
    const note = (action: 'step_up' | 'permission_denied', reason: string) =>
      withRlsContext(
        appPool,
        { userId: account!.id, role: account!.role, requestId: uuidv7(realClock.now()) },
        (tx) => recordAuditEvent(tx, { action, table: 'import', reason }),
      );
    for (let attempt = 1; attempt <= 3; attempt++) {
      const verdict = await verifyImportCode(authPool, env, {
        userId: account!.id,
        code: await prompt.secret('Authenticator code (6 digits): '),
      });
      if (verdict === 'ok') {
        await note('step_up', `history import (${operation.slice(0, 20)})`);
        return true;
      }
      if (verdict === 'ineligible')
        throw new ImportRefused('ROLE', 'This account may no longer run the import: nothing was done.');
      if (verdict === 'locked') {
        await note('permission_denied', 'history import: too many wrong codes (locked)');
        console.error('Too many wrong or reused codes: the account is locked for a while. Nothing was done.');
        return false;
      }
      await note('permission_denied', 'history import: wrong or reused authenticator code');
      console.error('Wrong code (a code already used anywhere is refused too: wait for the next one).');
    }
    return false;
  };

  if (args.mode === 'rollback') {
    await assertHistoryEnvironment(appPool, environment, []);
    const rb = historyRollbackConfirmation(args.target);
    console.log(
      `Rollback of history batch ${args.target}: the batch is marked rolled back and the clients it created are archived; nothing is deleted.`,
    );
    if ((await prompt.ask(`Type ${rb.phrase} to confirm: `)) !== rb.phrase)
      throw new ImportRefused('STEP_UP_REQUIRED', 'Confirmation not typed: nothing was done.');
    if (!(await stepUp(rb.operation)))
      throw new ImportRefused('STEP_UP_REQUIRED', 'Second factor not given: nothing was done.');
    const r = await rollbackHistory({
      appPool,
      actor: { ...actor, stepUpVerified: true },
      batchId: args.target,
      environment,
      stepUp: { userId: actor.id, operation: rb.operation },
    });
    const text = formatHistoryRollback(r);
    console.log(text);
    logReport('history-rollback', text);
    process.exitCode = r.blocked.length ? 1 : 0;
  } else {
    if (!existsSync(args.target)) {
      console.error('import:history: the folder was not found');
      process.exit(2);
    }
    const loaded = loadHistoryMapping(args.mapping!);
    if ('problem' in loaded) {
      console.error(loaded.problem);
      process.exit(1);
    }
    const files = listInputFiles(args.target);
    const base = { appPool, files, mapping: loaded.mapping, environment };
    const first = await runHistory({ ...base, actor, mode: args.mode === 'apply' ? 'dry-run' : args.mode });
    const text = formatHistoryReport(first);
    console.log(text);
    logReport(`history-${args.mode}`, text);
    if (args.mode !== 'apply') process.exitCode = first.problems.length || first.blocked.length ? 1 : 0;
    else if (first.problems.length) {
      console.error('Nothing applied: fix the problems above.');
      process.exitCode = 1;
    } else if (first.openQuarantine || Object.values(first.openLabels).some((n) => n > 0)) {
      console.error(
        'Nothing applied: decide the open mappings and quarantined rows on the History screens first.',
      );
      process.exitCode = 1;
    } else {
      const conf = historyConfirmation(first.setSha);
      console.log(
        `Confirmation covers: set ${first.setSha} (the files' bytes, the kind, the plant and the mapping).`,
      );
      if ((await prompt.ask(`Type ${conf.phrase} to apply: `)) !== conf.phrase)
        throw new ImportRefused('STEP_UP_REQUIRED', 'Confirmation not typed: nothing was written.');
      if (!(await stepUp(conf.operation)))
        throw new ImportRefused('STEP_UP_REQUIRED', 'Second factor not given: nothing was written.');
      const done = await runHistory({
        ...base,
        actor: { ...actor, stepUpVerified: true },
        mode: 'apply',
        stepUp: { userId: actor.id, operation: conf.operation },
      });
      const out = formatHistoryReport(done);
      console.log(out);
      logReport('history-apply', out);
      process.exitCode = done.applied || done.alreadyAppliedBatchId ? 0 : 1;
    }
  }
} catch (error) {
  if (error instanceof ImportRefused) {
    console.error(error.message);
    process.exitCode = 1;
  } else if (error instanceof ImportTransactionError) {
    console.error(`${error.code}: ${error.message}`);
    process.exitCode = error.code === 'COMMIT_OUTCOME_UNKNOWN' ? 4 : 1;
  } else {
    console.error(safeErrorLine(error));
    process.exitCode = 5;
  }
} finally {
  prompt.close();
  await Promise.all([appPool.end(), authPool.end()]);
}
