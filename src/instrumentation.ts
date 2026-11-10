/** Runs once at server start: refuse to serve with an invalid environment, or real data before the checklist. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertEnvOrExit } = await import('./lib/boot-check');
  assertEnvOrExit();
  const { assertRealDataOrExit, assertReservedAccountsOrExit, assertTrainingGuardOrExit } =
    await import('./modules/platform-security/boot');
  await assertTrainingGuardOrExit();
  await assertReservedAccountsOrExit();
  await assertRealDataOrExit();
  const { startJobSchedulerOrExit, syncSimClockOrExit } = await import('./modules/clock/boot');
  await syncSimClockOrExit();
  const { jobTimeOf } = await import('./app/job-time-of');
  await startJobSchedulerOrExit(jobTimeOf);
  const { startPushLoop } = await import('./app/push-loop');
  startPushLoop();
}
