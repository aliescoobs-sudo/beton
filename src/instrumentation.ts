/** Runs once at server start: refuse to serve with an invalid environment. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertEnvOrExit } = await import('./lib/boot-check');
  assertEnvOrExit();
}
