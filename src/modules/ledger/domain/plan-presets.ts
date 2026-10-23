import { addDaysIso } from './dates';
import type { PlanItemInput } from './plan';

/** Payment-plan presets of the order form (the office's usual terms); `custom` brings its own items. */
export const PLAN_PRESETS = ['cash', 'advance50', 'installments3', 'cheque30', 'custom'] as const;
export type PlanPreset = (typeof PLAN_PRESETS)[number];

/**
 * The plan items of a preset, as shares of the total (basis points; the last item absorbs the rounding in splitPlan):
 * cash = all on the delivery date; advance50 = half on the order date, half on delivery; installments3 = thirds 30, 60
 * and 90 days after delivery; cheque30 = one cheque 30 days after delivery.
 */
export function presetItems(
  preset: Exclude<PlanPreset, 'custom'>,
  dates: { orderDate: string; deliveryDate: string },
): PlanItemInput[] {
  const { orderDate, deliveryDate } = dates;
  switch (preset) {
    case 'cash':
      return [{ method: 'cash', dueDate: deliveryDate, share: { percentBp: 10_000 } }];
    case 'advance50':
      return [
        { method: 'advance', dueDate: orderDate, share: { percentBp: 5000 } },
        { method: 'cash', dueDate: deliveryDate, share: { percentBp: 5000 } },
      ];
    case 'installments3':
      return [
        { method: 'installment', dueDate: addDaysIso(deliveryDate, 30), share: { percentBp: 3333 } },
        { method: 'installment', dueDate: addDaysIso(deliveryDate, 60), share: { percentBp: 3333 } },
        { method: 'installment', dueDate: addDaysIso(deliveryDate, 90), share: { percentBp: 3334 } },
      ];
    case 'cheque30':
      return [{ method: 'cheque', dueDate: addDaysIso(deliveryDate, 30), share: { percentBp: 10_000 } }];
  }
}
