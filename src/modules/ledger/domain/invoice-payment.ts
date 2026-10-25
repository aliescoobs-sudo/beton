import { type Centimes, centimes } from '@/lib/money';

/** How much of an invoice the order's payments have covered. Derived, never stored (review of CP-L4, point 2). */
export const INVOICE_PAYMENT_STATES = ['unpaid', 'partial', 'paid'] as const;
export type InvoicePaymentState = (typeof INVOICE_PAYMENT_STATES)[number];

export interface InvoiceToSettle {
  id: string;
  /** Business date of the invoice; ties are broken by the number. */
  date: string;
  number: string;
  totalTtcCentimes: Centimes;
}

export interface InvoicePayment {
  state: InvoicePaymentState;
  paidCentimes: Centimes;
}

/**
 * What an order's payments cover, applied to its live invoices (not credit notes, not cancelled ones), oldest invoice
 * first: the covered plan items of the order pay the first invoice up to its total, then the next. The plan items stay the
 * source of truth (an invoice has no payment of its own); this only reads them against the invoices. Pure.
 */
export function settleInvoices(
  invoices: readonly InvoiceToSettle[],
  coveredCentimes: number,
): Map<string, InvoicePayment> {
  const out = new Map<string, InvoicePayment>();
  let left = Math.max(0, coveredCentimes);
  const ordered = [...invoices].sort(
    (a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number),
  );
  for (const inv of ordered) {
    const total = Number(inv.totalTtcCentimes);
    const paid = Math.min(total, left);
    left -= paid;
    out.set(inv.id, {
      paidCentimes: centimes(paid),
      state: paid >= total ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
    });
  }
  return out;
}
