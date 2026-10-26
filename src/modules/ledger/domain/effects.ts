import { can, type Role } from '@/modules/platform-security/domain/permissions';

/**
 * What a recorded action changed (ledger L35): a short list of typed facts computed by the service, filtered by role before
 * it leaves the service. Office sees the non-money facts only (a document number, the stock going down, a delivery
 * scheduled); owner and support also see the money ones (a receivable, a payable, the cash). Nothing here is invented by
 * AI and every amount comes from the same deterministic code that wrote the rows.
 */
export type Effect =
  // Non-money facts
  | {
      kind: 'document';
      document:
        'order' | 'bl' | 'invoice' | 'credit_note' | 'avoir' | 'purchase' | 'payment' | 'receipt' | 'quote';
      code: string;
    }
  | { kind: 'scheduled'; code: string; date: string }
  | { kind: 'remaining'; orderCode: string; remainingL: number }
  | {
      kind: 'stock';
      componentNameFr: string;
      componentNameAr: string;
      baseUnit: string;
      /** Signed, in base units: a load takes stock out, a receipt puts it in. */
      deltaBase: number;
      levelAfter: number;
      status: 'ok' | 'low' | 'short';
    }
  // Money facts: owner and support only
  | { kind: 'receivable'; clientCode: string | null; amountCentimes: number }
  | { kind: 'payable'; supplierCode: string | null; amountCentimes: number }
  | { kind: 'payment_in'; method: string; amountCentimes: number; cleared: boolean }
  | { kind: 'payment_out'; method: string; amountCentimes: number; cleared: boolean }
  | { kind: 'receivable_covered'; orderCode: string; amountCentimes: number }
  // A payment with no order named, spread over the client's open invoices (oldest due date first).
  | { kind: 'receivable_spread'; amountCentimes: number }
  | { kind: 'payable_covered'; purchaseCode: string; amountCentimes: number };

const MONEY_KINDS: ReadonlySet<Effect['kind']> = new Set([
  'receivable',
  'payable',
  'payment_in',
  'payment_out',
  'receivable_covered',
  'receivable_spread',
  'payable_covered',
]);

export const isMoneyEffect = (e: Effect): boolean => MONEY_KINDS.has(e.kind);

/** The effects a role may see: money facts only for a role that reads money (`effects.money`: owner and support). */
export function visibleEffects(effects: readonly Effect[], role: Role): Effect[] {
  return can(role, 'effects.money') ? [...effects] : effects.filter((e) => !isMoneyEffect(e));
}
