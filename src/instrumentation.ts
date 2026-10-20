/** Runs once at server start: refuse to serve with an invalid environment, or real data before the checklist. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertEnvOrExit } = await import('./lib/boot-check');
  assertEnvOrExit();
  const { assertRealDataOrExit } = await import('./modules/platform-security/boot');
  await assertRealDataOrExit();
  const { syncSimClockOrExit } = await import('./modules/clock/boot');
  await syncSimClockOrExit();
  const { startJobSchedulerOrExit } = await import('./modules/clock/boot');
  const { getPool } = await import('./lib/db/pools');
  const { readParameters } = await import('./modules/platform-security/service/parameter-service');
  await startJobSchedulerOrExit(async (parameterKey, defaultTime) => {
    const values = await readParameters(getPool('auth'));
    const configured = (values as Record<string, unknown>)[parameterKey];
    return typeof configured === 'string' ? configured : defaultTime;
  });
}
