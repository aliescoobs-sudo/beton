/** A calendar date `YYYY-MM-DD` (business dates compare as text). */
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const isIsoDate = (value: string): boolean => ISO_DATE.test(value);

/**
 * A post-dated cheque: written (dated) after the day it was received. Such a cheque may be presented early (D29), which
 * is allowed and flagged, never refused.
 */
export function isPostDated(writtenDate: string, receivedDate: string): boolean {
  return isIsoDate(writtenDate) && isIsoDate(receivedDate) && writtenDate > receivedDate;
}

/** An event (deposit, clearing) dated before the instrument's written date is early (AC-LED-14). */
export function isEarly(atDate: string, writtenDate: string | null): boolean {
  return writtenDate !== null && isIsoDate(atDate) && isIsoDate(writtenDate) && atDate < writtenDate;
}
