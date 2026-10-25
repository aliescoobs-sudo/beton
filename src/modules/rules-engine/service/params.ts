import type { ParameterValues } from '@/modules/platform-security/domain/parameters';
import { centimes } from '@/lib/money';
import { type EngineParams, parseHolidays } from '../domain';

/** The days of the 30-day window at which a bounce is reminded: "20,27" → [20, 27]. */
export const parseDayList = (text: string): number[] =>
  text
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);

/** The engine's parameters from the stored ones (the registry gives each its default); the screen may pick 7 or 14 days. */
export function engineParams(values: ParameterValues, horizonDays?: number): EngineParams {
  return {
    horizonDays: horizonDays ?? values.forecast_horizon_days,
    threshold: centimes(values.cash_safety_threshold_centimes),
    leadDays: values.alert_lead_days,
    legalReminderDays: values.legal_reminder_days,
    bounceReminderDays: parseDayList(values.bounce_reminder_days),
    clearingDelayDays: values.clearing_delay_days,
    postponeWorkingDays: values.postpone_working_days,
    advanceExtraBp: values.advance_extra_bp,
    discountRateBp: values.discount_rate_bp,
    splitBp: values.split_delivery_bp,
    vatRateBp: values.vat_rate_bp,
    purchaseLeadDays: values.purchase_lead_days,
    calendar: parseHolidays(values.holidays),
  };
}
