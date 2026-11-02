import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import type { SessionUser } from '@/modules/platform-security';
import {
  parseTruckEdit,
  parseTruckInput,
  parseTruckStatusInput,
  type Truck,
  type TruckLogStatus,
  type TruckStatusEntry,
} from '../domain/truck';
import { dateField } from '../domain/date-field';
import { datesInRange, isTruckAvailable } from '../domain/truck-availability';
import { inRequest, isMalformedId, isUniqueViolation, require } from './request';

export type TruckError = 'INVALID' | 'DUPLICATE' | 'NOT_FOUND';

interface TruckRow {
  id: string;
  code: string;
  plate: string;
  capacity_l: number;
  status: Truck['status'];
  kind: Truck['kind'];
  plant_id: string | null;
  stopped_decision: Truck['stoppedDecision'];
  pay_basis: Truck['payBasis'];
}

const COLUMNS = 'id, code, plate, capacity_l, status, kind, plant_id, stopped_decision, pay_basis';
const toTruck = (row: TruckRow): Truck => ({
  id: row.id,
  code: row.code,
  plate: row.plate,
  capacityL: row.capacity_l,
  status: row.status,
  kind: row.kind,
  plantId: row.plant_id,
  stoppedDecision: row.stopped_decision,
  payBasis: row.pay_basis,
});

interface EntryRow {
  id: string;
  truck_id: string;
  status: TruckLogStatus;
  from_date: string;
  to_date: string | null;
  reason: string;
  created_at: Date;
}

// `date` is read as text so a business date is never shifted by a time zone.
export const ENTRY_COLUMNS = `id, truck_id, status, to_char(from_date, 'YYYY-MM-DD') as from_date,
  to_char(to_date, 'YYYY-MM-DD') as to_date, reason, created_at`;

export const toEntry = (row: EntryRow): TruckStatusEntry => ({
  id: row.id,
  truckId: row.truck_id,
  status: row.status,
  fromDate: row.from_date,
  toDate: row.to_date,
  reason: row.reason,
  createdAt: row.created_at.toISOString(),
});

export async function listTrucks(appPool: pg.Pool, actor: SessionUser): Promise<Truck[]> {
  await require(appPool, actor, 'trucks.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<TruckRow>(`select ${COLUMNS} from truck order by code`),
  );
  return rows.map(toTruck);
}

export async function createTruck(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<Truck, TruckError>> {
  await require(appPool, actor, 'trucks.write');
  const parsed = parseTruckInput(input);
  if (!parsed.ok) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<TruckRow>(
        `insert into truck (id, code, plate, capacity_l, kind, plant_id, pay_basis) values ($1, $2, $3, $4, $5, $6, $7)
         returning ${COLUMNS}`,
        [
          uuidv7(realClock.now()),
          parsed.value.code,
          parsed.value.plate,
          parsed.value.capacityL,
          parsed.value.kind,
          parsed.value.plantId,
          parsed.value.payBasis,
        ],
      ),
    );
    return ok(toTruck(rows[0] as TruckRow));
  } catch (error) {
    if (isUniqueViolation(error)) return err('DUPLICATE');
    if (isPlantRuleViolation(error)) return err('INVALID');
    throw error;
  }
}

/** A refusal by the plant rules of the database (plant required, unknown or archived, kind). */
function isPlantRuleViolation(error: unknown): boolean {
  const e = error as { code?: string };
  return e.code === '23514' || e.code === '23503' || e.code === '23502';
}

/** Plate, capacity, plant, pay basis, the decision for a stopped truck and status (archive); the code is immutable (trigger). Managers only. */
export async function updateTruck(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
  input: unknown,
  status?: Truck['status'],
): Promise<Result<Truck, TruckError>> {
  await require(appPool, actor, 'trucks.write');
  const parsed = parseTruckEdit(input);
  if (!parsed.ok) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<TruckRow>(
        `update truck set plate = $2, capacity_l = $3, status = coalesce($4, status),
                plant_id = case when $5::boolean then $6 else plant_id end,
                pay_basis = case when $7::boolean then $8 else pay_basis end,
                stopped_decision = case when $9::boolean then $10 else stopped_decision end
          where id = $1 returning ${COLUMNS}`,
        [
          id,
          parsed.value.plate,
          parsed.value.capacityL,
          status ?? null,
          parsed.value.plantId !== undefined,
          parsed.value.plantId ?? null,
          parsed.value.payBasis !== undefined,
          parsed.value.payBasis ?? null,
          parsed.value.stoppedDecision !== undefined,
          parsed.value.stoppedDecision ?? null,
        ],
      ),
    );
    return rows[0] ? ok(toTruck(rows[0])) : err('NOT_FOUND');
  } catch (error) {
    if (isMalformedId(error)) return err('NOT_FOUND');
    if (isUniqueViolation(error)) return err('DUPLICATE');
    if (isPlantRuleViolation(error)) return err('INVALID');
    throw error;
  }
}

/** Plant only: a breakdown or roadblock (or `available`, ending one early). Never edits the truck itself. */
export async function logTruckStatus(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<TruckStatusEntry, TruckError>> {
  await require(appPool, actor, 'trucks.status.write');
  const parsed = parseTruckStatusInput(input);
  if (!parsed.ok) return err('INVALID');
  const { truckId, status, fromDate, toDate, reason } = parsed.value;
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<EntryRow>(
        `insert into truck_status_log (id, truck_id, status, from_date, to_date, reason, logged_by)
         values ($1, $2, $3, $4, $5, $6, $7) returning ${ENTRY_COLUMNS}`,
        [uuidv7(realClock.now()), truckId, status, fromDate, toDate, reason, actor.id],
      ),
    );
    return ok(toEntry(rows[0] as EntryRow));
  } catch (error) {
    // A malformed id, or a truck that does not exist (foreign key).
    if (isMalformedId(error) || (error as { code?: string }).code === '23503') return err('NOT_FOUND');
    throw error;
  }
}

/** The log of one truck, oldest first (the order that decides overlapping entries). */
export async function listTruckStatusLog(
  appPool: pg.Pool,
  actor: SessionUser,
  truckId: string,
): Promise<TruckStatusEntry[]> {
  await require(appPool, actor, 'trucks.read');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<EntryRow>(
        `select ${ENTRY_COLUMNS} from truck_status_log where truck_id = $1 order by created_at, id`,
        [truckId],
      ),
    );
    return rows.map(toEntry);
  } catch (error) {
    if (isMalformedId(error)) return [];
    throw error;
  }
}

const MAX_RANGE_DAYS = 366;

/**
 * The days of [from, to) on which the truck cannot be planned (breakdown, roadblock, archived), for the future
 * capacity check. Every signed-in role may ask.
 */
export async function unavailableDates(
  appPool: pg.Pool,
  actor: SessionUser,
  truckId: string,
  range: { from: string; to: string },
): Promise<Result<string[], 'INVALID' | 'NOT_FOUND'>> {
  await require(appPool, actor, 'trucks.read');
  const from = dateField.safeParse(range.from);
  const to = dateField.safeParse(range.to);
  if (!from.success || !to.success || to.data <= from.data) return err('INVALID');
  const days = datesInRange(from.data, to.data);
  if (days.length > MAX_RANGE_DAYS) return err('INVALID');
  let truck: Truck | undefined;
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<TruckRow>(`select ${COLUMNS} from truck where id = $1`, [truckId]),
    );
    truck = rows[0] ? toTruck(rows[0]) : undefined;
  } catch (error) {
    if (!isMalformedId(error)) throw error;
  }
  if (!truck) return err('NOT_FOUND');
  const log = await listTruckStatusLog(appPool, actor, truckId);
  return ok(days.filter((day) => !isTruckAvailable(truck, day, log)));
}
