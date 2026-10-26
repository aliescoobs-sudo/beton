import { z } from 'zod';
import type { AssistantTool } from '../../domain/tool-types';
import { boundedDate } from './shared';
import { rotationsOf } from './rotations';

const STEPS = [
  'planned',
  'loaded',
  'departed',
  'arrived',
  'unloading_started',
  'unloading_finished',
  'back',
] as const;

export const rotationOut = z.object({
  truck: z.string(),
  loadTime: z.string(),
  arriveTime: z.string(),
  m3: z.number(),
  client: z.string().nullable(),
  product: z.string().nullable(),
  step: z.enum(STEPS),
  bl: z.string().nullable(),
});

const out = z.object({ date: z.string(), count: z.number().int(), rotations: z.array(rotationOut) });

/** The day's rotations: truck, times, m³, client code, step reached, BL number. Office gets its restricted view. */
export const deliveriesToday: AssistantTool = {
  name: 'deliveries_today',
  kind: 'read',
  description:
    "The day's truck rotations: truck, planned load and arrival times, volume in m³, client code, product, the step reached and the BL number once loaded. Date defaults to today.",
  params: z.object({ date: z.string().optional() }).strict(),
  roles: ['owner', 'partner', 'office', 'plant', 'support'],
  permissions: ['trips.read', 'dispatch.read_office'],
  output: () => out,
  async run(ctx, args) {
    const { date } = args as { date?: string };
    if (date !== undefined && !boundedDate(ctx.today).safeParse(date).success)
      return { error: 'INVALID_DATE' };
    const day = date ?? ctx.today;
    const rotations = await rotationsOf(ctx, day);
    if (rotations === 'INVALID') return { error: 'INVALID_DATE' };
    return { date: day, count: rotations.length, rotations: rotations.slice(0, 40) };
  },
};
