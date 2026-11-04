import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';

// Batch B §16.5, §16.8, §16.9 (REQUIREMENTS-V1 §16): transfers between the plants, one timeline per order, the day close per plant.
// Reviewed database doors; quantities, times and people only.

export type PlantFlowError = 'INVALID' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT';
function failure(error: unknown): PlantFlowError {
  const e = error as { code?: string };
  if (e.code === '42501') return 'FORBIDDEN';
  if (e.code === '23505') return 'CONFLICT';
  if (e.code === '23514' || e.code === '23503' || isMalformedId(error)) return 'INVALID';
  throw error;
}
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export interface PlantTransfer {
  id: string;
  kind: 'material' | 'fuel';
  fromPlant: string;
  toPlant: string;
  componentId: string | null;
  qty: number;
  receivedQty: number | null;
  status: 'sent' | 'in_transit' | 'received';
  /** Sent minus received, once received. */
  variance: number | null;
  sentByRole: string | null;
  receivedByRole: string | null;
  createdAt: string;
}

export async function listTransfers(appPool: pg.Pool, actor: SessionUser): Promise<PlantTransfer[]> {
  await require(appPool, actor, 'transfers.read');
  const { rows } = await inRequest(appPool, actor, (tx) => tx.query('select * from public.transfers_list()'));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    fromPlant: r.from_plant,
    toPlant: r.to_plant,
    componentId: r.component_id,
    qty: Number(r.qty),
    receivedQty: r.received_qty === null ? null : Number(r.received_qty),
    status: r.status,
    variance: r.variance === null ? null : Number(r.variance),
    sentByRole: r.sent_by_role,
    receivedByRole: r.received_by_role,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

const sendInput = z.object({
  kind: z.enum(['material', 'fuel']),
  fromPlant: z.uuid(),
  toPlant: z.uuid(),
  componentId: z.uuid().nullish(),
  qty: z.number().int().positive().max(10_000_000_000),
  date: day,
  note: z.string().max(300).nullish(),
});

export async function sendTransfer(
  appPool: pg.Pool,
  actor: SessionUser,
  input: z.input<typeof sendInput>,
): Promise<Result<{ id: string }, PlantFlowError>> {
  await require(appPool, actor, 'transfers.write');
  const p = sendInput.safeParse(input);
  if (
    !p.success ||
    p.data.fromPlant === p.data.toPlant ||
    (p.data.kind === 'material') !== Boolean(p.data.componentId)
  )
    return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>('select public.transfer_send($1, $2, $3, $4, $5, $6::date, $7) as id', [
        p.data.kind,
        p.data.fromPlant,
        p.data.toPlant,
        p.data.componentId ?? null,
        p.data.qty,
        p.data.date,
        p.data.note ?? null,
      ]),
    );
    return ok({ id: rows[0]!.id });
  } catch (error) {
    return err(failure(error));
  }
}

export async function pickUpTransfer(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
  note?: string,
): Promise<Result<true, PlantFlowError>> {
  await require(appPool, actor, 'transfers.write');
  if (!z.uuid().safeParse(id).success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ ok: boolean }>('select public.transfer_pickup($1, $2) as ok', [id, note ?? null]),
    );
    return rows[0]?.ok ? ok(true) : err('NOT_FOUND');
  } catch (error) {
    return err(failure(error));
  }
}

/** The destination records what really arrived; the result is the variance (sent minus received). */
export async function receiveTransfer(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { id: string; qty: number; date: string; note?: string },
): Promise<Result<{ variance: number }, PlantFlowError>> {
  await require(appPool, actor, 'transfers.write');
  const p = z
    .object({
      id: z.uuid(),
      qty: z.number().int().min(0).max(10_000_000_000),
      date: day,
      note: z.string().max(300).optional(),
    })
    .safeParse(input);
  if (!p.success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ v: string }>('select public.transfer_receive($1, $2, $3::date, $4) as v', [
        p.data.id,
        p.data.qty,
        p.data.date,
        p.data.note ?? null,
      ]),
    );
    return ok({ variance: Number(rows[0]?.v ?? 0) });
  } catch (error) {
    return err(failure(error));
  }
}

export interface TimelineEntry {
  step: string;
  /** The device time: when the person tapped. */
  at: string;
  /** The server time: when it reached the server. */
  syncedAt: string;
  actorName: string | null;
  ref: string | null;
}

export async function getOrderTimeline(
  appPool: pg.Pool,
  actor: SessionUser,
  orderId: string,
): Promise<TimelineEntry[]> {
  await require(appPool, actor, 'timeline.read');
  if (!z.uuid().safeParse(orderId).success) return [];
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query('select * from public.order_timeline($1)', [orderId]),
  );
  return rows.map((r) => ({
    step: r.step,
    at: new Date(r.at).toISOString(),
    syncedAt: new Date(r.synced_at).toISOString(),
    actorName: r.actor_name,
    ref: r.ref,
  }));
}

export interface DayCloseItem {
  kind:
    'unconfirmed_load' | 'missing_bl' | 'stock_variance' | 'fuel_transfer_variance' | 'fuel_tank_negative';
  n: number;
  refs: string[];
  blocking: boolean;
}
export async function getDayCloseStatus(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { plantId: string; date: string },
): Promise<Result<DayCloseItem[], PlantFlowError>> {
  await require(appPool, actor, 'dayclose.read');
  if (!z.uuid().safeParse(input.plantId).success || !day.safeParse(input.date).success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query('select * from public.day_close_status($1, $2::date)', [input.plantId, input.date]),
    );
    return ok(rows.map((r) => ({ kind: r.kind, n: r.n, refs: r.refs, blocking: r.blocking })));
  } catch (error) {
    return err(failure(error));
  }
}

/** 'blocked' tells the owner and app_admin (they can close it knowingly with a note); 'already' is a second close. */
export async function closeDay(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { plantId: string; date: string; force?: boolean; note?: string },
): Promise<Result<'closed' | 'blocked' | 'already', PlantFlowError>> {
  await require(appPool, actor, 'dayclose.write');
  const p = z
    .object({
      plantId: z.uuid(),
      date: day,
      force: z.boolean().optional(),
      note: z.string().max(300).optional(),
    })
    .safeParse(input);
  if (!p.success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ r: 'closed' | 'blocked' | 'already' }>(
        'select public.close_day($1, $2::date, $3, $4) as r',
        [p.data.plantId, p.data.date, p.data.force ?? false, p.data.note ?? null],
      ),
    );
    return ok(rows[0]!.r);
  } catch (error) {
    return err(failure(error));
  }
}

export interface DayClose {
  plantId: string;
  date: string;
  forced: boolean;
  note: string | null;
  closedAt: string;
}
export async function listDayCloses(
  appPool: pg.Pool,
  actor: SessionUser,
  from: string,
  to: string,
): Promise<DayClose[]> {
  await require(appPool, actor, 'dayclose.read');
  if (!day.safeParse(from).success || !day.safeParse(to).success) return [];
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query(
      "select plant_id, to_char(close_date, 'YYYY-MM-DD') as d, forced, note, closed_at from public.day_closes_list($1::date, $2::date)",
      [from, to],
    ),
  );
  return rows.map((r) => ({
    plantId: r.plant_id,
    date: r.d,
    forced: r.forced,
    note: r.note,
    closedAt: new Date(r.closed_at).toISOString(),
  }));
}

export interface FuelTankLevel {
  plantId: string;
  plantName: string;
  /** Litres: the opening level, the fuel bought for the plant, received from the other plant, dispensed from the tank, sent. */
  openingL: number;
  asOf: string | null;
  purchasedL: number;
  receivedL: number;
  filledL: number;
  sentL: number;
  /** Fuel on its way to this plant (sent, not received yet): not in the level. */
  inTransitL: number;
  levelL: number;
}

/** The fuel tank of every plant the caller may see, computed from its movements (never stored). Litres only, no price. */
export async function getFuelTankLevels(appPool: pg.Pool, actor: SessionUser): Promise<FuelTankLevel[]> {
  await require(appPool, actor, 'transfers.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query('select * from public.fuel_tank_levels()'),
  );
  const litres = (ml: string | number) => Number(ml) / 1000;
  return rows.map((r) => ({
    plantId: r.plant_id,
    plantName: r.plant_name,
    openingL: litres(r.opening_ml),
    asOf: r.as_of ? new Date(r.as_of).toISOString().slice(0, 10) : null,
    purchasedL: litres(r.purchased_ml),
    receivedL: litres(r.received_ml),
    filledL: litres(r.filled_ml),
    sentL: litres(r.sent_ml),
    inTransitL: litres(r.in_transit_ml),
    levelL: litres(r.level_ml),
  }));
}

/** The level of a plant's fuel tank on the day it starts counting (once per plant). The sending plant manager, owner or app_admin. */
export async function setFuelTankOpening(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { plantId: string; litres: number; asOf: string },
): Promise<Result<true, PlantFlowError>> {
  await require(appPool, actor, 'transfers.write');
  const p = z
    .object({ plantId: z.uuid(), litres: z.number().int().min(0).max(1_000_000), asOf: day })
    .safeParse(input);
  if (!p.success) return err('INVALID');
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query('select public.set_fuel_tank_opening($1, $2, $3)', [
        p.data.plantId,
        p.data.litres,
        p.data.asOf,
      ]),
    );
    return ok(true);
  } catch (error) {
    return err(failure(error));
  }
}
