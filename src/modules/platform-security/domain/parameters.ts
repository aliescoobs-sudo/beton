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
  // Daily dispatch (SPEC-operations §7.1, AC-OPS-12…14): the timeline of one truck rotation. Every default is an assumption (🟡).
  loading_min: {
    default: 10,
    schema: z.number().int().min(0).max(60),
    description: 'Minutes to load a truck at the plant',
  },
  return_extra_min: {
    default: 10,
    schema: z.number().int().min(0).max(60),
    description: 'Minutes added to the way back (washing the drum, handing back at the plant)',
  },
  working_min: {
    default: 600,
    schema: z.number().int().min(240).max(1080),
    description: 'Minutes in a truck working day',
  },
  day_start_min: {
    default: 420,
    schema: z.number().int().min(0).max(1200),
    description: 'Minute of the day (from midnight) when the first rotation starts loading',
  },
  default_one_way_min: {
    default: 30,
    schema: z.number().int().min(5).max(180),
    description: 'One-way minutes used for an order whose site has no zone',
  }, // Production and consumption report (SPEC-operations §7.1, AC-OPS-19): a gap between the recettes and the counts above this is flagged.
  receipt_variance_bp: {
    default: 200,
    schema: z.number().int().min(0).max(5000),
    description:
      "Gap between the plant's usable count and the quantity the office documents that raises an alert (basis points)",
  },
  consumption_tolerance_bp: {
    default: 200,
    schema: z.number().int().min(0).max(2000),
    description:
      'Gap between the theoretical consumption and the physical counts that is flagged (basis points)',
  }, // Days of cover and reorder (SPEC-operations §7.1, AC-OPS-20): safety days on top of a supplier's lead time.
  // Stored documents (SPEC-integration §2, AC-INT-03): the largest BL scan or invoice photo accepted.
  upload_max_bytes: {
    default: 5_000_000,
    schema: z.number().int().min(100_000).max(8_000_000),
    description: 'Largest uploaded document, a BL scan or a supplier invoice photo (bytes)',
  },
  // The three-way match of a supplier invoice (SPEC-integration AC-INT-14): the gaps above these are flagged and block approval.
  match_qty_tolerance_bp: {
    default: 100,
    schema: z.number().int().min(0).max(2000),
    description:
      'Quantity gap (invoiced against received, or against ordered) tolerated on a supplier invoice (basis points)',
  },
  match_price_tolerance_bp: {
    default: 50,
    schema: z.number().int().min(0).max(2000),
    description: 'Unit price gap (invoiced against ordered) tolerated on a supplier invoice (basis points)',
  },
  reorder_margin_days: {
    default: 2,
    schema: z.number().int().min(0).max(30),
    description: "Safety days added to a supplier's lead time before a reorder is suggested",
  },

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
  // The assistant (SPEC-assistant §9). The limits can only be made stricter than the spec defaults, except the budget the owner may raise.
  'assistant.global_off': {
    default: 0,
    schema: z.number().int().min(0).max(1),
    description: 'Kill switch of the assistant for everyone: 1 = off, no provider call',
  },
  'assistant.disabled_roles': {
    default: '',
    schema: z
      .string()
      .regex(/^(?:(?:owner|partner|office|plant|support)(?:,(?:owner|partner|office|plant|support))*)?$/),
    description: 'Roles for which the assistant is off (comma-separated)',
  },
  'assistant.questions_per_10_min': {
    default: 20,
    schema: z.number().int().min(1).max(20),
    description: 'Questions one user may ask the assistant in ten minutes',
  },
  'assistant.questions_per_day': {
    default: 200,
    schema: z.number().int().min(1).max(200),
    description: 'Questions one user may ask the assistant in a day',
  },
  'assistant.budget_usd_month': {
    default: 20,
    schema: z.number().int().min(0).max(1000),
    description:
      'Monthly budget of the assistant in whole US dollars; at 100 % it answers from the tools only',
  },
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
