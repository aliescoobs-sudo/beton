import { z } from 'zod';
import { getConsumptionReport } from '@/modules/operations';
import type { AssistantTool } from '../../domain/tool-types';
import { displayQuantity } from '../../domain/units';

const row = z.object({
  nameFr: z.string(),
  nameAr: z.string(),
  unit: z.string(),
  theoretical: z.number(),
  adjustments: z.number(),
  counted: z.boolean(),
  actual: z.number().nullable(),
  variance: z.number().nullable(),
  flagged: z.boolean(),
});
const out = z.object({
  month: z.string(),
  toleranceBp: z.number().int(),
  producedM3: z.number(),
  count: z.number().int(),
  components: z.array(row),
});

const lastDay = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * Theoretical against actual consumption per component for a month: the production and consumption report, quantities only
 * (AC-ASSIST-24). The gap and its flag are the report's own; the tool only converts units and drops the ids.
 */
export const consumptionVariance: AssistantTool = {
  name: 'consumption_variance',
  kind: 'read',
  description:
    'Consumption of the month per component: theoretical (from the recettes), the physical-count adjustments, the actual and the gap, flagged when above the tolerance. Month as YYYY-MM, default the current month. Quantities only.',
  params: z
    .object({
      month: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
        .optional(),
    })
    .strict(),
  roles: ['owner', 'partner', 'plant', 'support'],
  permissions: ['reports.consumption'],
  output: () => out,
  async run(ctx, args) {
    const { month: asked } = args as { month?: string };
    const month = asked ?? ctx.today.slice(0, 7);
    // The month is bounded like every date the model can name: within 400 days of today.
    const first = `${month}-01`;
    if (Math.abs(Date.parse(`${first}T00:00:00Z`) - Date.parse(`${ctx.today}T00:00:00Z`)) > 430 * 86_400_000)
      return { error: 'INVALID_MONTH' };
    const report = await getConsumptionReport(ctx.appPool, ctx.actor, {
      from: first,
      to: lastDay(month),
      period: 'month',
    });
    if (!report.ok) return { error: 'INVALID_MONTH' };
    const byId = new Map(report.value.components.map((c) => [c.id, c]));
    const components = report.value.consumption
      .filter((r) => byId.has(r.componentId))
      .map((r) => {
        const c = byId.get(r.componentId)!;
        const q = (n: number) => displayQuantity(n, c.baseUnit);
        return {
          nameFr: c.nameFr,
          nameAr: c.nameAr,
          unit: q(0).unit,
          theoretical: q(r.theoretical).value,
          adjustments: q(r.adjustments).value,
          counted: r.counted,
          actual: r.actual === null ? null : q(r.actual).value,
          variance: r.variance === null ? null : q(r.variance).value,
          flagged: r.flagged,
        };
      });
    const produced = report.value.produced.reduce((sum, p) => sum + p.volumeL, 0);
    return {
      month,
      toleranceBp: report.value.toleranceBp,
      producedM3: Math.round(produced) / 1000,
      count: components.length,
      components: components.slice(0, 30),
    };
  },
};
