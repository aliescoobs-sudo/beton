import { type Env, loadEnv } from './env';

let cached: Env | undefined;

/** Validated server environment. Throws on first use if the configuration is invalid. */
export function getEnv(): Env {
  cached ??= loadEnv(process.env);
  return cached;
}
