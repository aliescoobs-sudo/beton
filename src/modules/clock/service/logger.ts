import { secretValuesOf } from '@/lib/env';
import { createLogger, type Logger, type LoggerOptions } from '@/lib/logger';
import { getEnv } from '@/lib/server-env';
import { type Clock, realClock } from './clock';

/** A logger whose `ts` on every line comes from `clock`. */
export function createClockLogger(options: Omit<LoggerOptions, 'now'> & { clock: Clock }): Logger {
  const { clock, ...rest } = options;
  return createLogger({ ...rest, now: () => clock.now().toISOString() });
}

let processLogger: Logger | undefined;

/**
 * Process-wide logger: real wall time from the clock module (log lines are operational events, so they
 * carry real time even in a simulation) and every secret from the environment scrubbed.
 */
export function getLogger(): Logger {
  processLogger ??= createClockLogger({ clock: realClock, secretValues: secretValuesOf(getEnv()) });
  return processLogger;
}
