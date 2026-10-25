import { addDaysIso } from '@/modules/ledger';
import { type ComponentProjection, draftPurchase, type PurchaseDraft, type SupplierHint } from './stock-risk';

/**
 * Days of cover and the reorder suggestion (SPEC-operations §7.3, AC-OPS-20, 21). Pure and deterministic, over the stock
 * projection the rules engine already computes from the open orders and the recette in force. A suggestion is a draft for
 * the owner to review and enter: nothing is ordered here.
 */
export interface ReorderParams {
  today: string;
  /** Calendar days used when the supplier has no lead time of its own (or none is known). */
  fallbackLeadDays: number;
  /** Safety days on top of the lead time (parameter `reorder_margin_days`). */
  marginDays: number;
}

export interface Reorder {
  componentId: string;
  /** Calendar days from today until the stock reaches zero under the open orders; null when it does not within the horizon. */
  coverDays: number | null;
  /** The first day the stock is below zero. */
  shortageDate: string | null;
  leadDays: number;
  leadFrom: 'supplier' | 'parameter';
  /** The cover is shorter than the lead time plus the margin: time to order. */
  needsOrder: boolean;
  /** The last day an order still arrives before the shortage (shortage − lead time); before today means already late. */
  orderBy: string | null;
  late: boolean;
  /** The draft purchase (owner and support: it needs the supplier and its last price); null otherwise. */
  draft: PurchaseDraft | null;
}

/** One component: its days of cover and, when the cover is too short for the supplier's lead time, a draft purchase. */
export function reorderFor(
  projection: ComponentProjection,
  hint: SupplierHint | null,
  p: ReorderParams,
): Reorder {
  const supplierLead = hint?.leadTimeDays ?? null;
  const leadDays = supplierLead ?? p.fallbackLeadDays;
  const coverDays = projection.daysUntilShortage;
  const shortageDate = projection.firstShortage?.date ?? null;
  const needsOrder = coverDays !== null && coverDays < leadDays + p.marginDays;
  const orderBy = shortageDate === null ? null : addDaysIso(shortageDate, -leadDays);
  return {
    componentId: projection.componentId,
    coverDays,
    shortageDate,
    leadDays,
    leadFrom: supplierLead === null ? 'parameter' : 'supplier',
    needsOrder,
    orderBy,
    late: orderBy !== null && orderBy < p.today,
    draft: needsOrder ? draftPurchase(projection, hint, p.today) : null,
  };
}

/** Every component with stock needs, the ones to order first (shortest cover) at the top. */
export function reorderAll(
  projections: readonly ComponentProjection[],
  hints: ReadonlyMap<string, SupplierHint>,
  p: ReorderParams,
): Reorder[] {
  return projections
    .map((c) => reorderFor(c, hints.get(c.componentId) ?? null, p))
    .sort(
      (a, b) =>
        Number(b.needsOrder) - Number(a.needsOrder) ||
        (a.coverDays ?? Number.MAX_SAFE_INTEGER) - (b.coverDays ?? Number.MAX_SAFE_INTEGER) ||
        a.componentId.localeCompare(b.componentId),
    );
}
