import type pg from 'pg';
import type { SessionUser } from '@/modules/platform-security';
import { type EngineParams, type Reorder, reorderAll, runStock, type StockRisk } from '../domain';
import { loadStockFacts } from './facts-stock';

export interface ReorderView {
  risk: StockRisk;
  /** Every component the open orders need, the ones to order first at the top. */
  reorders: Reorder[];
}

/**
 * Days of cover per component under the open orders and, where the cover is shorter than the supplier's lead time plus the
 * safety margin, a draft purchase for the owner to review and enter (AC-OPS-20, 21). Stock quantities are readable by the
 * plant and the partner; the supplier and its last price (so the draft) only by the owner and support. Nothing is ordered.
 */
export async function loadReorder(
  appPool: pg.Pool,
  actor: SessionUser,
  deps: { today: string; params: EngineParams },
): Promise<ReorderView> {
  const facts = await loadStockFacts(appPool, actor, deps.today, {
    horizonDays: deps.params.horizonDays,
    purchaseLeadDays: deps.params.purchaseLeadDays,
  });
  const { risk } = runStock(deps.today, facts, deps.params);
  const reorders = reorderAll(
    risk.components.filter((c) => c.needs > 0 || c.firstShortage !== null),
    facts.suppliers,
    {
      today: deps.today,
      fallbackLeadDays: deps.params.purchaseLeadDays,
      marginDays: deps.params.reorderMarginDays,
    },
  );
  return { risk, reorders };
}
