import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';
import type { FieldCipher } from '@/modules/master-data';

// C3 (REQUIREMENTS-V1 §16.6, basic): pump coordination. A pumped pour needs a pump scheduled on site before any truck can be planned
// for it; a truck planned before the pump is ready and a pump booked twice raise a conflict and an alert. Times are minutes since
// midnight, like the trip plan. Quantities and times only.

export type PumpError = 'INVALID' | 'NOT_FOUND' | 'HAS_PUMP' | 'STARTED';

const minute = z.number().int().min(0).max(1439);
const scheduleSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pumpId: z.uuid(),
  operatorId: z.uuid(),
  orderId: z.uuid().nullish(),
  onSiteMin: minute,
  setupMin: z.number().int().min(0).max(240).optional(),
  durationMin: z.number().int().min(10).max(960).optional(),
  siteLabel: z.string().trim().max(120).optional(),
  address: z.string().trim().max(300).nullish(),
  plannedM3: z.number().int().min(1).max(500).nullish(),
});

function failure(error: unknown): PumpError {
  const e = error as { code?: string; message?: string };
  const m = e.message ?? '';
  if (e.code === '23514') {
    if (/a pump is scheduled/.test(m)) return 'HAS_PUMP';
    if (/has started/.test(m)) return 'STARTED';
    if (/not a live order|unknown pump job/.test(m)) return 'NOT_FOUND';
    return 'INVALID';
  }
  if (e.code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  throw error;
}

/** Marks an order as a pumped pour (or not): while it is, no truck is planned for it before a pump is scheduled on site. */
export async function setOrderPumped(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { orderId: string; pumped: boolean } | { orderCode: string; pumped: boolean },
): Promise<Result<true, PumpError>> {
  await require(appPool, actor, 'pumps.plan');
  const byCode = 'orderCode' in input;
  if (
    byCode
      ? !/^CMD-[0-9]{4}-[0-9]{5,}$/i.test(input.orderCode.trim())
      : !z.uuid().safeParse(input.orderId).success
  )
    return err(byCode ? 'INVALID' : 'NOT_FOUND');
  try {
    await inRequest(appPool, actor, (tx) =>
      byCode
        ? tx.query('select public.set_order_pumped_by_code($1, $2)', [input.orderCode, input.pumped])
        : tx.query('select public.set_order_pumped($1, $2)', [input.orderId, input.pumped]),
    );
    return ok(true);
  } catch (error) {
    return err(failure(error));
  }
}

/** Schedules a pump on site for a day (and an order): the time on site, the set-up and the pumping duration. Checks conflicts at once. */
export async function schedulePumpJob(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  cipher: FieldCipher,
): Promise<Result<{ id: string }, PumpError>> {
  await require(appPool, actor, 'pumps.plan');
  const p = scheduleSchema.safeParse(input);
  if (!p.success) return err('INVALID');
  const v = p.data;
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>(
        'select public.schedule_pump_job($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as id',
        [
          v.date,
          v.pumpId,
          v.operatorId,
          v.orderId ?? null,
          v.onSiteMin,
          v.setupMin ?? null,
          v.durationMin ?? null,
          v.siteLabel ?? null,
          v.address ? cipher.seal(v.address) : null,
          v.plannedM3 ?? null,
        ],
      ),
    );
    return ok({ id: rows[0]?.id as string });
  } catch (error) {
    return err(failure(error));
  }
}

export async function reschedulePumpJob(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { jobId: string; onSiteMin: number },
): Promise<Result<true, PumpError>> {
  await require(appPool, actor, 'pumps.plan');
  if (!z.uuid().safeParse(input.jobId).success || !minute.safeParse(input.onSiteMin).success)
    return err('INVALID');
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query('select public.reschedule_pump_job($1, $2)', [input.jobId, input.onSiteMin]),
    );
    return ok(true);
  } catch (error) {
    return err(failure(error));
  }
}

export async function resolvePumpConflict(
  appPool: pg.Pool,
  actor: SessionUser,
  conflictId: string,
): Promise<Result<true, PumpError>> {
  await require(appPool, actor, 'pumps.plan');
  if (!z.uuid().safeParse(conflictId).success) return err('NOT_FOUND');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ ok: boolean }>('select public.resolve_pump_conflict($1) as ok', [conflictId]),
    );
    return rows[0]?.ok ? ok(true) : err('NOT_FOUND');
  } catch (error) {
    return err(failure(error));
  }
}

export interface PumpBoardRow {
  jobId: string;
  pumpCode: string;
  operatorName: string;
  orderId: string | null;
  orderCode: string | null;
  clientName: string | null;
  siteLabel: string;
  onSiteMin: number | null;
  setupMin: number;
  durationMin: number | null;
  plannedM3: number | null;
  /** The first truck planned for the order that day (minutes since midnight), null when none. */
  firstTruckArriveMin: number | null;
  openConflicts: number;
}
export interface PumpWaitingRow {
  orderId: string;
  orderCode: string;
  clientName: string;
  volumeL: number;
}
export interface PumpConflictRow {
  id: string;
  kind: 'pump_double_booked' | 'truck_before_pump';
  orderCode: string | null;
  pumpCode: string;
  otherPumpCode: string | null;
  tripArriveMin: number | null;
  onSiteMin: number | null;
  setupMin: number | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface PumpOption {
  id: string;
  code: string;
  label: string;
}
/** The pump trucks and the pump operators to choose from (code and name only). */
export async function listPumpOptions(
  appPool: pg.Pool,
  actor: SessionUser,
): Promise<{ pumps: PumpOption[]; operators: PumpOption[] }> {
  await require(appPool, actor, 'pumps.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ kind: 'pump' | 'operator'; id: string; code: string; label: string }>(
      'select * from public.pump_options()',
    ),
  );
  const pick = (k: string) =>
    rows.filter((r) => r.kind === k).map((r) => ({ id: r.id, code: r.code, label: r.label }));
  return { pumps: pick('pump'), operators: pick('operator') };
}

export async function getPumpDay(
  appPool: pg.Pool,
  actor: SessionUser,
  date: string,
): Promise<{ board: PumpBoardRow[]; waiting: PumpWaitingRow[]; conflicts: PumpConflictRow[] }> {
  await require(appPool, actor, 'pumps.read');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { board: [], waiting: [], conflicts: [] };
  return inRequest(appPool, actor, async (tx) => {
    const board = await tx.query<{
      job_id: string;
      pump_code: string;
      operator_name: string;
      order_id: string | null;
      order_code: string | null;
      client_name: string | null;
      site_label: string;
      on_site_min: number | null;
      setup_min: number;
      duration_min: number | null;
      planned_m3: number | null;
      first_truck_arrive_min: number | null;
      open_conflicts: number;
    }>('select * from public.pump_board($1)', [date]);
    const waiting = await tx.query<{
      order_id: string;
      order_code: string;
      client_name: string;
      volume_l: number;
    }>('select * from public.pump_waiting($1)', [date]);
    const conflicts = await tx.query<{
      id: string;
      kind: PumpConflictRow['kind'];
      order_code: string | null;
      pump_code: string;
      other_pump_code: string | null;
      trip_arrive_min: number | null;
      on_site_min: number | null;
      setup_min: number | null;
      created_at: Date;
      resolved_at: Date | null;
    }>('select * from public.pump_conflicts($1)', [date]);
    return {
      board: board.rows.map((r) => ({
        jobId: r.job_id,
        pumpCode: r.pump_code,
        operatorName: r.operator_name,
        orderId: r.order_id,
        orderCode: r.order_code,
        clientName: r.client_name,
        siteLabel: r.site_label,
        onSiteMin: r.on_site_min,
        setupMin: r.setup_min,
        durationMin: r.duration_min,
        plannedM3: r.planned_m3,
        firstTruckArriveMin: r.first_truck_arrive_min,
        openConflicts: r.open_conflicts,
      })),
      waiting: waiting.rows.map((r) => ({
        orderId: r.order_id,
        orderCode: r.order_code,
        clientName: r.client_name,
        volumeL: r.volume_l,
      })),
      conflicts: conflicts.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        orderCode: r.order_code,
        pumpCode: r.pump_code,
        otherPumpCode: r.other_pump_code,
        tripArriveMin: r.trip_arrive_min,
        onSiteMin: r.on_site_min,
        setupMin: r.setup_min,
        createdAt: r.created_at.toISOString(),
        resolvedAt: r.resolved_at?.toISOString() ?? null,
      })),
    };
  });
}
