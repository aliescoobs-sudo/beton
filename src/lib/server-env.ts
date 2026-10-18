import { type Env, loadEnv, secretValuesOf } from './env';
import { createLogger, type Logger } from './logger';

let cached: { env: Env; logger: Logger } | undefined;

function init() {
  if (!cached) {
    const env = loadEnv(process.env);
    cached = { env, logger: createLogger({ secretValues: secretValuesOf(env) }) };
  }
  return cached;
}

/** Validated server environment. Throws on first use if the configuration is invalid. */
export function getEnv(): Env {
  return init().env;
}

/** Process-wide logger that scrubs every secret from the environment. */
export function getLogger(): Logger {
  return init().logger;
}
