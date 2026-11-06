// Excel import for the production go-live. It reads a workbook (.xlsx; one sheet per kind of data) and a mapping file per sheet.
//   corepack pnpm import:excel --dry-run <file.xlsx> [--mapping <file-or-folder>] [--account <email>] [--opening-date YYYY-MM-DD]
//   corepack pnpm import:excel --apply   <file.xlsx> --account <email> [--mapping …] [--opening-date …]
//   corepack pnpm import:excel --rollback <run id>   --account <email>
//   corepack pnpm import:excel --init-mapping <folder>        (writes one editable mapping file per kind)
// --dry-run validates every row against the database in a transaction that is ALWAYS rolled back and saves a report in ./.logs/
//   (sheet, row number, problem; no name, ICE, phone or amount from the file). Nothing is written.
// --apply needs the owner or an app_admin account (--account), a typed confirmation tied to this very file, and a fresh code of that
//   account's authenticator (step-up). The whole file is ONE transaction: applied whole or not at all, audited with the file's
//   sha256 (never its contents). The same bytes are never imported twice; a changed file skips the rows that exist.
// --rollback takes out of use what a run created (archive, cancel; nothing is deleted) and lists what stays sealed by design.
// Refused when TRAINING_MODE=true, on a simulated database, on a database with the training marker, and unless REAL_DATA=true.
// Sheets and headers: docs/IMPORT-EXCEL.md. Without --mapping the built-in French sheet names and usual headers apply.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { loadEnv } from '../src/lib/env.ts';
import { realClock } from '../src/modules/clock/index.ts';
import {
  assertImportEnvironment,
  defaultMappings,
  formatRollbackReport,
  formatWorkbookReport,
  ImportRefused,
  importEnvironmentProblem,
  importWorkbook,
  loadMappingFiles,
  rollbackImport,
  writeDefaultMappingFiles,
} from '../src/modules/importer/index.ts';
import { recordAuditEvent } from '../src/modules/platform-security/index.ts';
import { withRlsContext } from '../src/lib/db/rls-context.ts';
import { uuidv7 } from '../src/lib/uuidv7.ts';
import { handleHelp } from './cli-help';
import {
  confirmationPhrase,
  findImportAccount,
  parseArgs,
  rollbackPhrase,
  verifyTotp,
} from './import-excel-lib';
import { createPrompt } from './prompt';

handleHelp(import.meta.url);

const args = parseArgs(process.argv.slice(2));
if (args.problems.length || !args.mode || !args.target) {
  for (const p of args.problems) console.error(`import:excel: ${p}`);
  console.error(
    'usage: import:excel --dry-run|--apply <file.xlsx> | --rollback <run id> | --init-mapping <folder>  (see --help)',
  );
  process.exit(2);
}

if (args.mode === 'init-mapping') {
  const { written, skipped } = writeDefaultMappingFiles(args.target);
  for (const f of written) console.log(`written ${f}`);
  for (const f of skipped) console.log(`kept (already there) ${f}`);
  process.exit(0);
}

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const env = loadEnv(process.env);
const environment = {
  trainingMode: env.TRAINING_MODE,
  realData: env.REAL_DATA,
  simulationEnabled: env.SIMULATION_ENABLED,
};
// Before any file or connection: the flags alone can already refuse (the database is asked again inside the import).
if (environment.trainingMode) {
  console.error(importEnvironmentProblem(environment, false));
  process.exit(1);
}

const logReport = (name: string, text: string) => {
  mkdirSync('.logs', { recursive: true });
  const path = `.logs/import-${name}-${realClock.now().toISOString().replace(/[:.]/g, '-')}.txt`;
  writeFileSync(path, `${text}\n`);
  console.log(`(report saved in ${path})`);
};

const appPool = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const authPool = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 1 });
const prompt = createPrompt();
try {
  await assertImportEnvironment(appPool, environment);

  // who acts: the named account, or for a dry run the single active owner
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

  // the second factor: three tries, every failure and the success are audited
  const stepUp = async (): Promise<boolean> => {
    const note = (action: 'step_up' | 'permission_denied', reason: string) =>
      withRlsContext(
        appPool,
        { userId: account!.id, role: account!.role, requestId: uuidv7(realClock.now()) },
        (tx) => recordAuditEvent(tx, { action, table: 'import', reason }),
      );
    for (let attempt = 1; attempt <= 3; attempt++) {
      const code = await prompt.secret('Authenticator code (6 digits): ');
      if (await verifyTotp(authPool, env, account!.id, code)) {
        await note('step_up', 'excel import');
        return true;
      }
      await note('permission_denied', 'excel import: wrong authenticator code');
      console.error('Wrong code.');
    }
    return false;
  };

  if (args.mode === 'rollback') {
    console.log(
      `Rollback of run ${args.target}: archives what it created and cancels its cheques; nothing is deleted.`,
    );
    if (
      (await prompt.ask(`Type ${rollbackPhrase(args.target)} to confirm: `)) !== rollbackPhrase(args.target)
    )
      throw new ImportRefused('STEP_UP_REQUIRED', 'Confirmation not typed: nothing was done.');
    if (!(await stepUp()))
      throw new ImportRefused('STEP_UP_REQUIRED', 'Second factor not given: nothing was done.');
    const r = await rollbackImport({
      appPool,
      actor: { ...actor, stepUpVerified: true },
      runId: args.target,
      environment,
    });
    const text = formatRollbackReport(r);
    console.log(text);
    logReport('rollback', text);
    process.exitCode = r.blocked.length ? 1 : 0;
  } else {
    if (!existsSync(args.target)) {
      console.error(`import:excel: ${args.target} not found`);
      process.exit(2);
    }
    const loaded = args.mapping
      ? loadMappingFiles(args.mapping)
      : { mappings: defaultMappings(), problems: [] as string[] };
    if (loaded.problems.length) {
      for (const p of loaded.problems) console.error(`mapping: ${p}`);
      process.exit(1);
    }
    const file = readFileSync(args.target);
    if (file.length > 20 * 1024 * 1024) {
      console.error('import:excel: the file is larger than 20 MB');
      process.exit(2);
    }
    const base = {
      appPool,
      file,
      mappings: loaded.mappings,
      environment,
      // mapping files the person wrote name sheets that must be there; the built-in defaults cover every kind, so a partial workbook is fine
      requireEveryMappedSheet: args.mapping !== null,
      openingDate: args.openingDate ?? undefined,
    };
    // the dry run always comes first, also before an apply: the person confirms what they have just read
    const dry = await importWorkbook({ ...base, actor, mode: 'dry-run' });
    const dryText = formatWorkbookReport(dry);
    console.log(dryText);
    logReport('dry-run', dryText);
    const clean =
      dry.fileProblems.length === 0 &&
      dry.totals.error === 0 &&
      dry.totals.failed === 0 &&
      dry.sheets.every((s) => s.report.missingColumns.length === 0);
    if (args.mode === 'dry-run') process.exitCode = clean ? 0 : 1;
    else if (!clean) {
      console.error('Nothing applied: fix the problems above and run the dry run again.');
      process.exitCode = 1;
    } else if (dry.alreadyImportedRunId) process.exitCode = 0;
    else {
      const phrase = confirmationPhrase(dry.sha256);
      if ((await prompt.ask(`Type ${phrase} to apply this file to the production database: `)) !== phrase)
        throw new ImportRefused('STEP_UP_REQUIRED', 'Confirmation not typed: nothing was written.');
      if (!(await stepUp()))
        throw new ImportRefused('STEP_UP_REQUIRED', 'Second factor not given: nothing was written.');
      const done = await importWorkbook({
        ...base,
        actor: { ...actor, stepUpVerified: true },
        mode: 'apply',
      });
      const text = formatWorkbookReport(done);
      console.log(text);
      logReport('apply', text);
      process.exitCode = done.applied ? 0 : 1;
    }
  }
} catch (error) {
  if (error instanceof ImportRefused) {
    console.error(error.message);
    process.exitCode = 1;
  } else throw error;
} finally {
  prompt.close();
  await Promise.all([appPool.end(), authPool.end()]);
}
