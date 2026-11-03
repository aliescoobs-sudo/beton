import type pg from 'pg';
import { z } from 'zod';
import { getFinanceCash, validRange } from './report-service';
import { addMonths, validDate } from '../domain/period';
import { suggestSteel } from '../domain/forecast';
import type { FinanceActor } from './request';
const amount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export async function simulateSteel(pool: pg.Pool, actor: FinanceActor, input: unknown) {
  const v = z
    .object({
      from: z.string().refine(validDate),
      to: z.string().refine(validDate),
      bankCostCentimes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      deals: z
        .array(
          z.object({
            deliveryDate: z.string().refine(validDate),
            cashCentimes: amount,
            purchaseCentimes: amount,
            chequeCount: z.number().int().min(1).max(3),
          }),
        )
        .min(1)
        .max(12),
    })
    .parse(input);
  const horizon = v.deals.reduce((end, d) => {
    const tail = addMonths(d.deliveryDate, d.chequeCount);
    return tail > end ? tail : end;
  }, v.to);
  validRange(v.from, horizon, 730);
  const base = await getFinanceCash(pool, actor, v.from, horizon);
  return suggestSteel(base.openingCentimes, v.from, horizon, base.flows, v.deals, v.bankCostCentimes);
}
