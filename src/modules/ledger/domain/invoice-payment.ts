import { type Centimes, centimes } from '@/lib/money';

/** How much of an invoice has been paid. Derived, never stored (review of CP-L4, point 2). */
export const INVOICE_PAYMENT_STATES = ['unpaid', 'partial', 'paid'] as const;
export type InvoicePaymentState = (typeof INVOICE_PAYMENT_STATES)[number];

export interface InvoicePayment {
  state: InvoicePaymentState;
  paidCentimes: Centimes;
}

/**
 * The state of an invoice from what the database derived: the payments of each order it bills, covering the live invoices
 * oldest due date first (`public.invoice_payment_state()`). The plan items stay the source of truth; an invoice has no payment
 * of its own. Pure.
 */
export function invoicePayment(totalTtcCentimes: number, paidCentimes: number): InvoicePayment {
  const paid = Math.min(Math.max(0, paidCentimes), Math.max(0, totalTtcCentimes));
  return {
    paidCentimes: centimes(paid),
    state: paid >= totalTtcCentimes ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
  };
}
