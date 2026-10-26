import { z } from 'zod';
import { loadReorder } from '@/modules/rules-engine';
import type { AssistantTool } from '../../domain/tool-types';
import { displayQuantity } from '../../domain/units';

const component = z.object({
  nameFr: z.string(),
  nameAr: z.string(),
  unit: z.string(),
  level: z.number(),
  coverDays: z.number().nullable(),
  shortageDate: z.string().nullable(),
  orderBy: z.string().nullable(),
  late: z.boolean(),
  needsOrder: z.boolean(),
});
const out = z.object({ count: z.number().int(), components: z.array(component) });

/**
 * Stock per component and the days of cover under the open orders, with the date to order by. No supplier, no price, no draft
 * purchase for anyone (D94: the plant and the partner get none, and a draft is a separate tool). Quantities in tonnes or litres, converted by code.
 */
export const stockAndCover: AssistantTool = {
  name: 'stock_and_cover',
  kind: 'read',
  description:
    'Stock level per component (in the unit given: tonnes or litres) and days of cover under the open orders, the shortage date and the date to order by. Use it for questions about cement, sand, gravel, additives and when to reorder.',
  params: z.object({}).strict(),
  roles: ['owner', 'partner', 'plant', 'support'],
  permissions: ['stock.read'],
  output: () => out,
  async run(ctx) {
    const { risk, reorders } = await loadReorder(ctx.appPool, ctx.actor, {
      today: ctx.today,
      params: ctx.engine,
    });
    const byId = new Map(reorders.map((r) => [r.componentId, r]));
    const components = risk.components
      .map((c) => {
        const r = byId.get(c.componentId);
        const q = displayQuantity(c.level, c.baseUnit);
        return {
          nameFr: c.nameFr,
          nameAr: c.nameAr,
          unit: q.unit,
          level: q.value,
          coverDays: r?.coverDays ?? null,
          shortageDate: r?.shortageDate ?? null,
          orderBy: r?.orderBy ?? null,
          late: r?.late ?? false,
          needsOrder: r?.needsOrder ?? false,
        };
      })
      .sort((a, b) => (a.coverDays ?? Number.MAX_SAFE_INTEGER) - (b.coverDays ?? Number.MAX_SAFE_INTEGER));
    return { count: components.length, components: components.slice(0, 30) };
  },
};
