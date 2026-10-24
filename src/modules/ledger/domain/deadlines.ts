import { daysBetween } from './reversal';

/** Days ahead that count as "due soon" on the deadlines screen. */
export const DUE_SOON_DAYS = 7;

export type DeadlineStatus = 'overdue' | 'due_soon' | 'upcoming';

/** Where a legal date stands against a day: past it, within the next week, or further away (business dates). */
export function deadlineStatus(date: string, asOf: string): DeadlineStatus {
  const days = daysBetween(asOf, date);
  if (days < 0) return 'overdue';
  return days <= DUE_SOON_DAYS ? 'due_soon' : 'upcoming';
}

export type DeadlineKind = 'invoice_to_issue' | 'receivable_due' | 'payable_due';

export interface Deadline {
  kind: DeadlineKind;
  date: string;
  status: DeadlineStatus;
  /** The document the date belongs to (an order for an invoice to issue, an invoice, a purchase). */
  documentCode: string;
  partyName: string;
  /** Centimes still to invoice, to collect or to pay; null for an invoice to issue (the amount is not known yet). */
  amountCentimes: number | null;
}

/** Sorts by date then code; the order of the screen. */
export const byDeadline = (a: Deadline, b: Deadline): number =>
  a.date.localeCompare(b.date) || a.documentCode.localeCompare(b.documentCode);
