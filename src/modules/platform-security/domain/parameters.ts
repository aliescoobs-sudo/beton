import { z } from 'zod';

const minutesOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

/**
 * Configurable parameters (SPEC: thresholds, tolerances…), stored in the `parameter` table, owner-only writes.
 * Security parameters are bounded so they can only be made STRICTER than the spec defaults (principle #0).
 * Later modules add their own entries here (VAT, horizon, tolerances…).
 */
export const PARAMETERS = {
  'auth.lockout_account_failures': {
    default: 5,
    schema: z.number().int().min(3).max(5),
    description: 'Failed logins per account before a lockout',
  },
  'auth.lockout_ip_failures': {
    default: 20,
    schema: z.number().int().min(5).max(20),
    description: 'Failed logins per IP before a lockout',
  },
  'auth.lockout_window_minutes': {
    default: 15,
    schema: z.number().int().min(15).max(60),
    description: 'Lockout window and duration (minutes)',
  },
  'auth.session_absolute_hours': {
    default: 12,
    schema: z.number().int().min(1).max(12),
    description: 'Absolute session lifetime (hours)',
  },
  'auth.step_up_minutes': {
    default: 10,
    schema: z.number().int().min(1).max(10),
    description: 'Maximum age of the second factor for sensitive actions (minutes)',
  },
  'clock.job.morning_recompute': {
    default: '06:30',
    schema: minutesOfDay,
    description: 'Morning recompute (HH:MM)',
  },
  'clock.job.daily_brief': { default: '07:00', schema: minutesOfDay, description: 'Daily brief (HH:MM)' },
  'clock.job.due_reminders': {
    default: '07:05',
    schema: minutesOfDay,
    description: 'Due-date reminders (HH:MM)',
  },
  'clock.job.day_close': { default: '20:00', schema: minutesOfDay, description: 'Day close (HH:MM)' },
} as const;

export type ParameterKey = keyof typeof PARAMETERS;
export type ParameterValues = {
  [K in ParameterKey]: (typeof PARAMETERS)[K]['default'] extends number ? number : string;
};

export const PARAMETER_KEYS = Object.keys(PARAMETERS) as ParameterKey[];

export function isParameterKey(key: string): key is ParameterKey {
  return Object.hasOwn(PARAMETERS, key);
}

export function defaultParameters(): ParameterValues {
  return Object.fromEntries(PARAMETER_KEYS.map((k) => [k, PARAMETERS[k].default])) as ParameterValues;
}

export function parseParameter<K extends ParameterKey>(
  key: K,
  value: unknown,
): { ok: true; value: ParameterValues[K] } | { ok: false } {
  if (!isParameterKey(key)) return { ok: false };
  const parsed = (PARAMETERS[key].schema as z.ZodType).safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data as ParameterValues[K] } : { ok: false };
}
