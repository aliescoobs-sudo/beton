import { z } from 'zod';
import type { AssistantTool } from '../../domain/tool-types';
import { rotationOut } from './deliveries-today';
import { CLIENT_CODE } from './shared';
import { rotationsOf } from './rotations';

const out = z.object({ found: z.boolean(), rotation: rotationOut.nullable() });

/** The next planned rotation of today that is not loaded yet, optionally for one truck or one client. */
export const nextLoad: AssistantTool = {
  name: 'next_load',
  kind: 'read',
  description:
    'The next planned rotation of today that is not loaded yet: truck, planned times, volume in m³, client code. Optionally for one truck code or one client code.',
  params: z
    .object({
      truck: z
        .string()
        .regex(/^[A-Za-z0-9-]{1,12}$/)
        .optional(),
      client: CLIENT_CODE.optional(),
    })
    .strict(),
  roles: ['owner', 'office', 'plant'],
  permissions: ['trips.read', 'dispatch.read_office'],
  output: () => out,
  async run(ctx, args) {
    const { truck, client } = args as { truck?: string; client?: string };
    const rotations = await rotationsOf(ctx, ctx.today);
    if (rotations === 'INVALID') return { found: false, rotation: null };
    const next = rotations
      .filter((r) => r.step === 'planned')
      .filter((r) => (truck ? r.truck.toLowerCase() === truck.toLowerCase() : true))
      .filter((r) => (client ? r.client === client : true))
      .sort((a, b) => a.loadTime.localeCompare(b.loadTime))[0];
    return { found: next !== undefined, rotation: next ?? null };
  },
};
