// Imports an Excel (.xlsx) or CSV file of master data. DRY RUN by default: it validates every row, says what exists already,
// and writes nothing. Add --apply to write; that only starts when the dry run found no error, and a re-run skips what exists.
//   corepack pnpm import:excel <kind> <file> [--apply] [--opening-date YYYY-MM-DD]
// kind: concrete_types | components | recipes | clients | suppliers | trucks | selling_prices | opening_balances | cheques_in_transit
// Import in that order (recipes need the types and the components; prices need the types; opening balances and cheques in transit
// need the clients and suppliers). Columns: see docs/RUNBOOK.md §4. The report is printed and
// saved in ./.logs/. The import runs as the owner account, server-side; every row is audited like a screen entry.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { loadEnv } from '../src/lib/env.ts';
import { realClock } from '../src/modules/clock/index.ts';
import {
  formatReport,
  IMPORT_KINDS,
  type ImportKind,
  readSheet,
  runImport,
} from '../src/modules/importer/index.ts';
import { handleHelp } from './cli-help';

handleHelp(import.meta.url);

const args = process.argv.slice(2);
const kind = args[0] as ImportKind | undefined;
const file = args[1];
const apply = args.includes('--apply');
const openingDate = args.includes('--opening-date') ? args[args.indexOf('--opening-date') + 1] : undefined;
if (!kind || !(IMPORT_KINDS as readonly string[]).includes(kind) || !file || !existsSync(file)) {
  console.error(
    `usage: import:excel <${IMPORT_KINDS.join('|')}> <file.xlsx|file.csv> [--apply] [--opening-date YYYY-MM-DD]`,
  );
  process.exit(2);
}

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const env = loadEnv(process.env);
const appPool = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const authPool = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 1 });
try {
  const owner = (
    await authPool.query<{ id: string; name: string; email: string }>(
      `select id, name, email from "user" where role = 'owner' and status = 'active'`,
    )
  ).rows[0];
  if (!owner) throw new Error('No active owner account: create it first (user:create-owner)');
  const report = await runImport(kind, readSheet(readFileSync(file)), {
    appPool,
    actor: { ...owner, role: 'owner', locale: 'fr', twoFactorEnabled: true, reenrolRequired: false },
    openingDate,
    apply,
  });
  const text = formatReport(report);
  console.log(text);
  mkdirSync('.logs', { recursive: true });
  writeFileSync(
    `.logs/import-${kind}-${realClock.now().toISOString().replace(/[:.]/g, '-')}.txt`,
    `${text}\n`,
  );
  process.exitCode =
    report.counts.error > 0 || report.counts.failed > 0 || report.missingColumns.length ? 1 : 0;
} finally {
  await Promise.all([appPool.end(), authPool.end()]);
}
