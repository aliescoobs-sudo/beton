/** The stages an order goes through, in the order they happen (SPEC-integration §4, I3.1). */
export const CHAIN_STAGES = ['ordered', 'planned', 'loaded', 'delivered', 'invoiced', 'paid'] as const;
export type ChainStage = (typeof CHAIN_STAGES)[number];

export type StageState = 'none' | 'partial' | 'complete';

/**
 * Where a quantity stage stands against what was ordered: nothing yet, part of it, all of it (or more). An order of zero
 * litres cannot exist, but a negative or empty quantity is "none". Pure.
 */
export function stageState(doneL: number, orderedL: number): StageState {
  if (doneL <= 0) return 'none';
  return doneL >= orderedL ? 'complete' : 'partial';
}

/** The first stage that is not complete, i.e. what the order is waiting for (null when every stage is complete). */
export function waitingFor(
  states: Record<Exclude<ChainStage, 'paid'>, StageState>,
  paid: 'paid' | 'partial' | 'unpaid' | null,
): ChainStage | null {
  for (const stage of ['planned', 'loaded', 'delivered', 'invoiced'] as const)
    if (states[stage] !== 'complete') return stage;
  return paid === null || paid === 'paid' ? null : 'paid';
}
