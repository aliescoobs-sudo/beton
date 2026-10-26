import { z } from 'zod';
import { computeRun } from '@/modules/rules-engine';
import type { AssistantTool } from '../../domain/tool-types';

const day = z.object({
  date: z.string(),
  baseCentimes: z.number().int(),
  worstCentimes: z.number().int(),
  inflowCentimes: z.number().int(),
  outflowCentimes: z.number().int(),
});
const out = z.object({
  horizonDays: z.number().int(),
  cashTodayCentimes: z.number().int(),
  days: z.array(day),
  lowest: z.object({ date: z.string(), balanceCentimes: z.number().int() }).nullable(),
  black: z
    .object({
      date: z.string(),
      severity: z.string(),
      scenario: z.string(),
      shortfallCentimes: z.number().int(),
    })
    .nullable(),
  alertCount: z.number().int(),
  alerts: z.array(z.object({ rule: z.string(), severity: z.string(), date: z.string() })),
});

/** The rules engine's cash forecast and its alerts as the engine states them: one run, nothing stored, nothing computed here. */
export const forecast: AssistantTool = {
  name: 'forecast',
  kind: 'read',
  description:
    "The cash forecast of the rules engine for the coming working days: balance per day (normal and worst case), the lowest day, the black day if any, and the alerts. Amounts are placeholders to quote as written. Use it for questions about next week's cash.",
  params: z.object({ days: z.number().int().min(1).max(14).optional() }).strict(),
  roles: ['owner', 'support'],
  permissions: ['cash.read'],
  output: () => out,
  async run(ctx, args) {
    const { days } = args as { days?: number };
    // The engine's own run: it is read only here (the owner's dashboard is what stores first detections).
    const run = await computeRun(ctx.appPool, ctx.actor, ctx.today, ctx.engine);
    const limit = days ?? ctx.engine.horizonDays;
    return {
      horizonDays: ctx.engine.horizonDays,
      cashTodayCentimes: run.encaisse,
      days: run.forecast.slice(0, limit).map((d) => ({
        date: d.date,
        baseCentimes: d.base,
        worstCentimes: d.worst,
        inflowCentimes: d.inflow,
        outflowCentimes: d.outflow,
      })),
      lowest: run.lowest ? { date: run.lowest.date, balanceCentimes: run.lowest.balance } : null,
      black: run.black
        ? {
            date: run.black.date,
            severity: run.black.severity,
            scenario: run.black.scenario,
            shortfallCentimes: run.black.shortfall,
          }
        : null,
      alertCount: run.hits.length,
      alerts: run.hits
        .slice(0, 10)
        .map((h) => ({ rule: h.ruleId, severity: h.severity, date: h.targetDate })),
    };
  },
};
