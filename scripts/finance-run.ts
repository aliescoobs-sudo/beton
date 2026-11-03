// Local worktree runner: refuse every database-dependent command unless it targets this isolated copy.
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
export function assertFinanceTarget(env: Record<string, string | undefined>) {
  for (const name of ['APP', 'AUTH', 'MIGRATOR', 'SYSTEM', 'BACKUP', 'SEED']) {
    const key = 'DATABASE_URL_' + name;
    let u: URL;
    try {
      u = new URL(env[key] ?? '');
    } catch {
      throw new Error(key + ': missing isolated URL');
    }
    if (
      !['postgres:', 'postgresql:'].includes(u.protocol) ||
      !['127.0.0.1', 'localhost'].includes(u.hostname) ||
      u.port !== '5542' ||
      ![
        '/belgobeton_finance',
        '/belgobeton_test',
        '/belgobeton_e2e',
        '/belgobeton_ddl_scratch',
        '/belgobeton_restore_test',
        '/belgobeton_scenario_test',
      ].includes(u.pathname)
    )
      throw new Error(key + ': refusing non-finance database');
  }
  if (env.REAL_DATA !== 'false') throw new Error('Finance worktree runner requires synthetic data');
}
export function financeBuildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = {
    ...env,
    SIMULATION_ENABLED: 'false',
    ASSISTANT_ENABLED: 'false',
    AI_EXTRACTION_ENABLED: 'false',
  };
  for (const key of [
    'POSTGRES_SUPERUSER_PASSWORD',
    'DATABASE_URL_BACKUP',
    'DATABASE_URL_SEED',
    'BACKUP_AGE_IDENTITY_FILE',
  ])
    delete (clean as NodeJS.ProcessEnv)[key];
  return clean;
}
if (import.meta.main) {
  if (process.argv.includes('--help')) {
    console.log(
      'finance-run <integration|e2e|build|migrate> [test filters]; isolated synthetic database on 5542 only',
    );
    process.exit(0);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (
    realpathSync(process.cwd()) !== realpathSync(root) ||
    execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'codex/finance'
  )
    throw new Error('Finance runner requires the codex/finance worktree root');
  for (const file of ['.env.local', '.env.ops']) if (existsSync(file)) process.loadEnvFile(file);
  assertFinanceTarget(process.env);
  const mode = process.argv[2],
    filters = process.argv.slice(3);
  const commands: Record<string, string[]> = {
    integration: ['node_modules/vitest/vitest.mjs', 'run', '--project', 'integration', ...filters],
    e2e: ['node_modules/@playwright/test/cli.js', 'test', ...filters],
    build: ['node_modules/next/dist/bin/next', 'build'],
    migrate: ['--import', './scripts/register-ts-paths.mjs', 'scripts/db-migrate.ts'],
  };
  if (!mode || !commands[mode]) throw new Error('Unknown finance command');
  if (mode === 'e2e') {
    // Prepare before Playwright starts its web servers. Recreating after server boot can kill its idle PG clients.
    await (await import('../e2e/global-setup.ts')).default();
    process.env.FINANCE_E2E_PREPARED = 'true';
  }

  const result = spawnSync(process.execPath, commands[mode], {
    stdio: 'inherit',
    env: mode === 'build' ? financeBuildEnvironment(process.env) : process.env,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
