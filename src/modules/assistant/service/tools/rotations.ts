import { getOfficeDispatch, listTrips, TRIP_STEPS, type TripStep } from '@/modules/operations';
import { can } from '@/modules/platform-security';
import { litresToM3, minutesToClock } from '../../domain/units';
import type { ToolContext } from '../../domain/tool-types';

export type Step = 'planned' | TripStep;

/** One rotation as the assistant states it: the same facts for every role, from the service its screen uses. */
export interface Rotation {
  truck: string;
  loadTime: string;
  arriveTime: string;
  m3: number;
  /** The client's code; null when the name a screen shows is not one we know by code. */
  client: string | null;
  product: string | null;
  step: Step;
  bl: string | null;
}

const reachedStep = (clock: Partial<Record<TripStep, string>>): Step =>
  [...TRIP_STEPS].reverse().find((s) => clock[s] !== undefined) ?? 'planned';

/**
 * The rotations of a day. Plant, owner, partner and support read the trips (`trips.read`); office reads its restricted view
 * (`dispatch.read_office`: truck, client name, litres, times, last step, BL number; no order, no price, no plate in the answer).
 * Driver names, plates, sites and zones never go out.
 */
export async function rotationsOf(ctx: ToolContext, date: string): Promise<Rotation[] | 'INVALID'> {
  if (can(ctx.actor.role, 'trips.read')) {
    const r = await listTrips(ctx.appPool, ctx.actor, date);
    if (!r.ok) return 'INVALID';
    return r.value.map((t) => ({
      truck: t.truckCode,
      loadTime: minutesToClock(t.plan.loadMin),
      arriveTime: minutesToClock(t.plan.arriveMin),
      m3: litresToM3(t.volumeL),
      client: t.clientCode,
      product: t.typeLabel,
      step: reachedStep(t.clock),
      bl: t.blNo,
    }));
  }
  const r = await getOfficeDispatch(ctx.appPool, ctx.actor, date);
  if (!r.ok) return 'INVALID';
  return r.value.map((t) => ({
    truck: t.truckCode,
    loadTime: minutesToClock(t.loadMin),
    arriveTime: minutesToClock(t.arriveMin),
    m3: litresToM3(t.volumeL),
    client: ctx.codeOfName(t.clientName),
    product: null,
    step: t.step ?? 'planned',
    bl: t.blNo,
  }));
}
