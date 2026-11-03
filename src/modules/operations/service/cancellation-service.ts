import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';

// R6 (REQUIREMENTS-V1 §8): the seven cancellation cases. Every write is one reviewed database door that reads the real state of the
// order and its rotations; this service only validates the input and maps the refusals. Quantities and times only, no amount.

export type CancellationError = 'INVALID' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'MISMATCH';

function failure(error: unknown): CancellationError {
  const e = error as { code?: string };
  if (e.code === '42501') return 'FORBIDDEN';
  if (e.code === '23505') return 'CONFLICT';
  if (e.code === '23514') return 'MISMATCH';
  if (e.code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  throw error;
}

export interface CancellationCase {
  id: string;
  caseNo: number;
  orderCode: string;
  tripSeq: number | null;
  blNo: string | null;
  plantId: string | null;
  status: 'open' | 'decided';
  decision: string | null;
  reason: string | null;
  surplusL: number | null;
  unloadedL: number | null;
  lossL: number | null;
  lossFuelL: number | null;
  lossMinutes: number | null;
  clientCharged: boolean;
  avoirRequired: boolean;
  redirectOrderCode: string | null;
  redirectAcknowledged: boolean;
  openedAt: string;
}

export async function listCancellations(appPool: pg.Pool, actor: SessionUser): Promise<CancellationCase[]> {
  await require(appPool, actor, 'cancellations.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query(
      `select c.id, c.case_no, o.code as order_code, t.seq as trip_seq, d.bl_no, c.plant_id, c.status, c.decision, c.reason,
              c.surplus_volume_l, c.unloaded_volume_l, c.loss_volume_l, c.loss_fuel_l, c.loss_minutes, c.client_charged,
              c.avoir_required, ro.code as redirect_code, c.redirect_ack_at, c.opened_at
         from cancellation_case c
         join sales_order o on o.id = c.order_id
         left join trip_plan t on t.id = c.trip_id
         left join delivery d on d.id = c.delivery_id
         left join sales_order ro on ro.id = c.redirect_order_id
        order by c.opened_at desc limit 200`,
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    caseNo: r.case_no,
    orderCode: r.order_code,
    tripSeq: r.trip_seq,
    blNo: r.bl_no,
    plantId: r.plant_id,
    status: r.status,
    decision: r.decision,
    reason: r.reason,
    surplusL: r.surplus_volume_l,
    unloadedL: r.unloaded_volume_l,
    lossL: r.loss_volume_l,
    lossFuelL: r.loss_fuel_l,
    lossMinutes: r.loss_minutes,
    clientCharged: r.client_charged,
    avoirRequired: r.avoir_required,
    redirectOrderCode: r.redirect_code,
    redirectAcknowledged: r.redirect_ack_at !== null,
    openedAt: new Date(r.opened_at).toISOString(),
  }));
}

const reasonText = z.string().trim().max(500);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Cases 1 and 2: the order was never produced. Reversing entry, unstarted rotations leave the plan, "do not load" goes out. */
export async function cancelUnproducedOrder(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { orderId: string; reason?: string },
  deps: { today: string },
): Promise<Result<{ id: string }, CancellationError>> {
  await require(appPool, actor, 'cancellations.open');
  const p = z.object({ orderId: z.uuid(), reason: reasonText.optional() }).safeParse(input);
  if (!p.success || !day.safeParse(deps.today).success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>('select public.cancel_unproduced_order($1, $2, $3::date) as id', [
        p.data.orderId,
        p.data.reason ?? null,
        deps.today,
      ]),
    );
    return ok({ id: rows[0]?.id as string });
  } catch (error) {
    return err(failure(error));
  }
}

/** Cases 3 to 7, about one rotation. The case number must match what the tracking shows (the database checks it). */
export async function openTripCase(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { tripId: string; caseNo: number; reason?: string; unloadedL?: number; sampleTaken?: boolean },
  deps: { now: Date },
): Promise<Result<{ id: string }, CancellationError>> {
  await require(appPool, actor, 'cancellations.open');
  const p = z
    .object({
      tripId: z.uuid(),
      caseNo: z.number().int().min(3).max(7),
      reason: reasonText.optional(),
      unloadedL: z.number().int().positive().max(100000).optional(),
      sampleTaken: z.boolean().optional(),
    })
    .safeParse(input);
  if (!p.success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>('select public.open_trip_case($1, $2, $3, $4, $5, $6) as id', [
        p.data.tripId,
        p.data.caseNo,
        p.data.reason ?? null,
        p.data.unloadedL ?? null,
        p.data.sampleTaken ?? null,
        deps.now.toISOString(),
      ]),
    );
    return ok({ id: rows[0]?.id as string });
  } catch (error) {
    return err(failure(error));
  }
}

export interface RedirectCandidate {
  orderId: string;
  orderCode: string;
  typeCode: string;
  remainingL: number;
  siteLabel: string | null;
}

/** Same-day open orders that could take the surplus (same type or a lower class, enough remaining workable time). */
export async function listRedirectCandidates(
  appPool: pg.Pool,
  actor: SessionUser,
  caseId: string,
  deps: { now: Date },
): Promise<RedirectCandidate[]> {
  await require(appPool, actor, 'cancellations.read');
  if (!z.uuid().safeParse(caseId).success) return [];
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query('select * from public.redirect_candidates($1, $2)', [caseId, deps.now.toISOString()]),
  );
  return rows.map((r) => ({
    orderId: r.order_id,
    orderCode: r.order_code,
    typeCode: r.type_code,
    remainingL: r.remaining_l,
    siteLabel: r.site_label,
  }));
}

const decision = z.object({
  caseId: z.uuid(),
  decision: z.enum(['redirect', 'loss', 'return_extra', 'join', 'replacement_truck']),
  redirectOrderId: z.uuid().optional(),
  addressEnc: z.string().max(500).optional(),
  lossVolumeL: z.number().int().min(0).max(100000).optional(),
  lossFuelL: z.number().int().min(0).max(5000).optional(),
  lossMinutes: z.number().int().min(0).max(2880).optional(),
  note: z.string().max(300).optional(),
  chargeClient: z.boolean().optional(),
});

/** Redirect or loss (and the truck-incident choices). Owner and app_admin, or the plant manager when the policy allows. */
export async function decideCancellation(
  appPool: pg.Pool,
  actor: SessionUser,
  input: z.input<typeof decision>,
  deps: { now: Date },
): Promise<Result<true, CancellationError>> {
  await require(appPool, actor, 'cancellations.decide');
  const p = decision.safeParse(input);
  if (!p.success) return err('INVALID');
  const v = p.data;
  if (v.decision === 'redirect' && !v.redirectOrderId) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ ok: boolean }>(
        'select public.decide_cancellation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as ok',
        [
          v.caseId,
          v.decision,
          v.redirectOrderId ?? null,
          v.addressEnc ?? null,
          v.lossVolumeL ?? null,
          v.lossFuelL ?? null,
          v.lossMinutes ?? null,
          v.note ?? null,
          v.chargeClient ?? null,
          deps.now.toISOString(),
        ],
      ),
    );
    return rows[0]?.ok ? ok(true) : err('NOT_FOUND');
  } catch (error) {
    return err(failure(error));
  }
}

export async function setCancellationPolicy(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { plantMayDecide: boolean; clientCharged: boolean },
): Promise<Result<true, CancellationError>> {
  await require(appPool, actor, 'cancellations.policy');
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query('select public.set_cancellation_policy($1, $2)', [input.plantMayDecide, input.clientCharged]),
    );
    return ok(true);
  } catch (error) {
    return err(failure(error));
  }
}

export async function getCancellationPolicy(
  appPool: pg.Pool,
  actor: SessionUser,
): Promise<{ plantMayDecide: boolean; clientCharged: boolean }> {
  await require(appPool, actor, 'cancellations.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ plant_may_decide: boolean; client_charged: boolean }>('select * from cancellation_policy'),
  );
  return {
    plantMayDecide: rows[0]?.plant_may_decide ?? false,
    clientCharged: rows[0]?.client_charged ?? false,
  };
}
