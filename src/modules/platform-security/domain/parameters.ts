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
  // Ledger (DECISIONS 66; plan decisions 8): configurable, never hard-coded. Each document stores the VAT rate in force.
  vat_rate_bp: {
    default: 2000,
    schema: z.number().int().min(0).max(2500),
    description: 'VAT rate in basis points (2000 = 20 %), stored on each document when it is created',
  },
  reversal_window_days: {
    default: 2,
    schema: z.number().int().min(0).max(30),
    description: 'Days after which a ledger entry can only be reversed by the owner',
  },
  clearing_delay_days: {
    default: 1,
    schema: z.number().int().min(0).max(10),
    description: 'Working days before a deposited cheque or LCN clears',
  },
  // Operations (SPEC-operations R4, AC-OPS-08): a load warns when the trip plus the unloading exceeds the limit.
  concrete_limit_min: {
    default: 90,
    schema: z.number().int().min(30).max(240),
    description: 'Minutes concrete stays workable after loading (R4)',
  },
  load_excess_tolerance_bp: {
    default: 500,
    schema: z.number().int().min(0).max(5000),
    description:
      'Load beyond the order volume that is only a minor excess, as a share of the order (basis points)',
  },
  unloading_min: {
    default: 30,
    schema: z.number().int().min(0).max(120),
    description: 'Minutes to unload a truck on site',
  },
} as const;

export type ParameterKey = keyof typeof PARAMETERS;
export type ParameterValues = {
  [K in ParameterKey]: (typeof PARAMETERS)[K]['default'] extends number ? number : string;
};
  // Rules engine and owner dashboard (SPEC-rules-engine §3, §4, §6). Every default is an assumption (🟡) to revisit with
  // the owner; none is written in the domain code.
  forecast_horizon_days: {
    default: 14,
    schema: z.number().int().min(7).max(30),
    description: 'Working days of the cash forecast (the screen offers 7 or 14)',
  },
  cash_safety_threshold_centimes: {
    default: 0,
    schema: z.number().int().min(0).max(100_000_000_000),
    description: 'Balance below which a day is a deficit day (centimes)',
  },
  alert_lead_days: {
    default: 2,
    schema: z.number().int().min(1).max(7),
    description: 'Days ahead that raise a due-date alert',
  },
  legal_reminder_days: {
    default: 7,
    schema: z.number().int().min(1).max(30),
    description: 'Days ahead of a legal date (law 69-21) that raise a reminder',
  },
  bounce_reminder_days: {
    default: '20,27',
    schema: z.string().regex(/^\d{1,2}(,\d{1,2})*$/, 'days, comma separated'),
    description: 'Days after a bounce at which the 30-day window is reminded',
  },
  holidays: {
    default: '',
    schema: z.string().regex(/^(\d{4}-\d{2}-\d{2}([,\s]+\d{4}-\d{2}-\d{2})*)?$/, 'YYYY-MM-DD dates'),
    description: 'Holidays (dates, comma separated): not working days',
  },
  purchase_lead_days: {
    default: 2,
    schema: z.number().int().min(0).max(30),
    description: 'Days between ordering and receiving goods (expected receipts)',
  },
  postpone_working_days: {
    default: 4,
    schema: z.number().int().min(1).max(30),
    description: 'Working days a supplier payment is pushed back in the "postpone" option',
  },
  advance_extra_bp: {
    default: 3000,
    schema: z.number().int().min(0).max(10000),
    description: 'Extra advance asked of a client, as a share of the order (basis points)',
  },
  discount_rate_bp: {
    default: 800,
    schema: z.number().int().min(0).max(3000),
    description: 'Yearly bank rate for discounting an LCN (basis points)',
  },
  split_delivery_bp: {
    default: 5000,
    schema: z.number().int().min(1000).max(9000),
    description:
      'Share of an order moved to the next working day in the "split delivery" option (basis points)',
  },

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

/** next-intl treats dots in message keys as nesting, so labels are stored under the key with `.` → `__`. */
export function parameterLabelKey(key: string): string {
  return key.replaceAll('.', '__');
}

/** A stored value over the default: an absent or no longer valid value falls back to the default. */
export function parameterOrDefault<K extends ParameterKey>(key: K, stored: unknown): ParameterValues[K] {
  const parsed =
    stored === null || stored === undefined ? { ok: false as const } : parseParameter(key, stored);
  return parsed.ok ? parsed.value : (PARAMETERS[key].default as ParameterValues[K]);
}
