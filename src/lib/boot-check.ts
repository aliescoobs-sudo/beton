import { getEnv } from './server-env';

/** Node-only: stop the process when the environment is invalid (AC-SEC-11). */
export function assertEnvOrExit(): void {
  try {
    getEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
