import type { BusinessDate } from './business-date';
import { casablancaInstant } from './instants';

/** Input and result of the owner's advance server action (`src/app/advance-action.ts`). */
export type AdvanceInput = { byDays: number } | { toDate: string; toTime: string };

export type AdvanceActionResult =
  | { ok: true; failedJob?: string }
  | {
      ok: false;
      error:
        | 'UNAUTHENTICATED'
        | 'FORBIDDEN'
        | 'STEP_UP_REQUIRED'
        | 'REENROL_REQUIRED'
        | 'INVALID'
        | 'SIMULATION_DISABLED'
        | 'NOT_FORWARD'
        | 'TOO_FAR'
        | 'SERVER_ERROR';
    };

export type AdvanceTarget = { to: Date } | { byDays: number };

export const MAX_ADVANCE_DAYS = 366;

/** The advance was refused before any job ran: the target is not later than `sim_now`, or too far away. */
export class AdvanceRejectedError extends Error {
  constructor(readonly reason: 'NOT_FORWARD' | 'TOO_FAR') {
    super(
      reason === 'NOT_FORWARD'
        ? 'sim_now can only move forward'
        : `Cannot advance by more than ${MAX_ADVANCE_DAYS} days at once`,
    );
    this.name = 'AdvanceRejectedError';
  }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validates untrusted action input; `null` when it is not a whole number of days or a real Casablanca date and time. */
export function parseAdvanceInput(input: unknown): AdvanceTarget | null {
  if (typeof input !== 'object' || input === null) return null;
  const { byDays, toDate, toTime } = input as Record<string, unknown>;
  if (byDays !== undefined) {
    return Number.isInteger(byDays) && (byDays as number) >= 1 && (byDays as number) <= MAX_ADVANCE_DAYS
      ? { byDays: byDays as number }
      : null;
  }
  if (typeof toDate !== 'string' || typeof toTime !== 'string' || !TIME.test(toTime)) return null;
  try {
    return { to: casablancaInstant(toDate as BusinessDate, toTime) };
  } catch {
    return null;
  }
}
