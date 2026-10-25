import { addCentimes, type Centimes, mulDivRound } from '@/lib/money';
import { addWorkingDays, type Calendar } from './calendar';
import {
  type ComponentProjection,
  draftPurchase,
  projectStock,
  type PurchaseDraft,
  splitDemand,
  type StockRiskInput,
  type SupplierHint,
} from './stock-risk';

/** Basis points in 100 %. */
const BP_DENOMINATOR = 10_000;
/** Orders offered for a split, the biggest users of the missing component first. */
const MAX_SPLITS = 2;

export interface StockOptionParams {
  today: string;
  calendar: Calendar;
  /** Parameter `split_delivery_bp`: the share of an order's volume moved to the next working day. */
  splitBp: number;
  /** Rate stored on the purchase when it is entered (parameter `vat_rate_bp`); only used for the cash estimate. */
  vatRateBp: number;
  /** Parameter `purchase_lead_days`: working days between ordering and receiving. */
  purchaseLeadDays: number;
}

export interface StockOption {
  id: string;
  kind: 'EMERGENCY-PURCHASE' | 'SPLIT-DELIVERY';
  componentId: string;
  /** Share of the missing quantity this option removes, in basis points. */
  coverageBp: number;
  /** A draft purchase for the owner to review and enter: nothing is ordered by the engine. */
  draft: PurchaseDraft | null;
  /** Estimated cash out, VAT included, at the last price; null when there is no price. */
  cashImpact: Centimes | null;
  /** The goods would be in time for the shortage day. */
  inTime: boolean;
  arrivesOn: string | null;
  split: {
    orderId: string;
    orderCode: string;
    clientCode: string;
    fromDate: string;
    toDate: string;
    movedL: number;
    /** Where the shortage lands after the split (null: none within the horizon). */
    shortageAfter: string | null;
  } | null;
}

/** Options for a component that runs short (SPEC §6): buy what is missing, or push part of an order one working day. */
export function generateStockOptions(
  input: StockRiskInput,
  projection: ComponentProjection,
  hint: SupplierHint | null,
  p: StockOptionParams,
): StockOption[] {
  const shortage = projection.firstShortage;
  if (!shortage || projection.maxShortage <= 0) return [];
  const options: StockOption[] = [];

  const draft = draftPurchase(projection, hint, p.today);
  if (draft) {
    const arrivesOn = addWorkingDays(p.today, p.purchaseLeadDays, p.calendar);
    options.push({
      id: `EMERGENCY-PURCHASE:${projection.componentId}`,
      kind: 'EMERGENCY-PURCHASE',
      componentId: projection.componentId,
      coverageBp: BP_DENOMINATOR,
      draft,
      cashImpact:
        draft.estimatedHtCentimes === null
          ? null
          : addCentimes(
              draft.estimatedHtCentimes,
              mulDivRound(draft.estimatedHtCentimes, p.vatRateBp, BP_DENOMINATOR),
            ),
      inTime: arrivesOn <= shortage.date,
      arrivesOn,
      split: null,
    });
  }

  const toDate = addWorkingDays(shortage.date, 1, p.calendar);
  const users = projection.contributions
    .filter((c) => c.date === shortage.date)
    .sort((a, b) => b.qty - a.qty || a.orderId.localeCompare(b.orderId))
    .slice(0, MAX_SPLITS);
  for (const u of users) {
    const demand = input.demands.find(
      (d) => d.orderId === u.orderId && (d.date === u.date || (d.date < p.today && u.date === p.today)),
    );
    if (!demand) continue;
    const movedL = Math.floor((demand.volumeL * p.splitBp) / BP_DENOMINATOR);
    if (movedL <= 0) continue;
    const after = projectStock({
      ...input,
      demands: splitDemand(input.demands, u.orderId, demand.date, movedL, toDate),
    }).components.find((c) => c.componentId === projection.componentId);
    const atShortage = after?.days.find((day) => day.date === shortage.date);
    if (!after || !atShortage) continue;
    // What it removes on the shortage day, against what is missing that day; where the shortage goes is shown apart.
    const gained = Math.min(-shortage.level, atShortage.level - shortage.level);
    if (gained <= 0) continue;
    options.push({
      id: `SPLIT-DELIVERY:${u.orderId}:${projection.componentId}`,
      kind: 'SPLIT-DELIVERY',
      componentId: projection.componentId,
      coverageBp: Math.min(
        BP_DENOMINATOR,
        mulDivRound(gained as Centimes, BP_DENOMINATOR, projection.maxShortage),
      ),
      draft: null,
      cashImpact: null,
      inTime: true,
      arrivesOn: null,
      split: {
        orderId: u.orderId,
        orderCode: u.orderCode,
        clientCode: u.clientCode,
        fromDate: u.date,
        toDate,
        movedL,
        shortageAfter: after.firstShortage?.date ?? null,
      },
    });
  }

  return options.sort(
    (a, b) => b.coverageBp - a.coverageBp || Number(b.inTime) - Number(a.inTime) || a.id.localeCompare(b.id),
  );
}
