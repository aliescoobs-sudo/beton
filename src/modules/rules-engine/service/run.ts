import type pg from 'pg';
import { can, type SessionUser } from '@/modules/platform-security';
import { type EngineParams, runEngine } from '../domain';
import { loadMoneyFacts } from './facts-money';
import { loadStockFacts } from './facts-stock';

export type EngineRun = ReturnType<typeof runEngine>;

/**
 * One run of the engine as the requester: money facts only for the roles that read money (owner, support), stock facts
 * for everyone who reads the stock. The same facts and the same day always give the same run (AC-RE-01).
 */
export async function computeRun(
  appPool: pg.Pool,
  actor: SessionUser,
  today: string,
  params: EngineParams,
): Promise<EngineRun> {
  const money = can(actor.role, 'cash.read') ? await loadMoneyFacts(appPool, actor, today) : null;
  const stock = await loadStockFacts(appPool, actor, today, {
    horizonDays: params.horizonDays,
    purchaseLeadDays: params.purchaseLeadDays,
  });
  return runEngine(today, money, stock, params);
}
