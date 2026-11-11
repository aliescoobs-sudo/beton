import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import type { FieldCipher } from '@/modules/master-data';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';
import {
  deriveStages,
  type StageRow,
  type StageSource,
  type StageView,
} from '@/modules/operations/domain/trip-stages';
import { emergencyStage, type EmergencyStage } from '../domain/steps';
import type { QueueAction, SyncOutcome } from '../domain/queue';

// What the phone reads and writes. The doors are database functions that check the caller's own driver id; a result here never
// carries a price, an amount or a balance (a test lists the keys).

export interface DriverTrip {
  id: string;
  seq: number;
  orderCode: string;
  typeLabel: string;
  volumeL: number;
  clientName: string;
  contactName: string | null;
  phone: string | null;
  siteLabel: string | null;
  address: string | null;
  /** A link to open the address in the phone's map app; built here, no call is made. */
  mapUrl: string | null;
  zoneName: string | null;
  truckCode: string;
  loadMin: number;
  blNo: string | null;
  loadingStartedAt: string | null;
  steps: Record<string, string>;
  /** T9: the shared status, the same one the plant's board shows: who recorded each stage and when (an implicit stage is marked). */
  stages: StageView[];
  stage: EmergencyStage;
  unloadedL: number | null;
  /** How many photos of the signed BL the office already holds for this rotation. */
  blPhotos: number;
  /** The phone of the trip's plant (set by the owner / app_admin), null when unset: the screen shows a tel: link or nothing. */
  plantPhone: string | null;
}

export interface DriverInstruction {
  id: string;
  tripId: string;
  kind: 'continue' | 'extra_load' | 'redirect' | 'join';
  address: string | null;
  mapUrl: string | null;
  note: string | null;
  joinTruckCode: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
}

/** The training instance sends nothing outside (T1): no map link, whatever the address or the office typed. */
const outboundOff = () => process.env.TRAINING_MODE === 'true';
/**
 * F07: a map link hands the site address to a third party (Google) when it is tapped, so it is OFF by default.
 * The driver sees the address as text with a copy button; an operator who has accepted that transfer (and recorded it
 * in the CNDP file) turns it on with MAP_LINKS_ENABLED=true. Training mode keeps it off whatever the flag says.
 */
export const mapLinksOn = () => process.env.MAP_LINKS_ENABLED === 'true' && !outboundOff();
export const mapLink = (address: string | null): string | null =>
  address && mapLinksOn()
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
    : null;

/** The driver's rotations of a day with their steps, the instructions of the last days. */
export async function getDriverDay(
  appPool: pg.Pool,
  driver: SessionUser,
  date: string,
  cipher: FieldCipher,
): Promise<{ trips: DriverTrip[]; instructions: DriverInstruction[]; officePhone: string | null }> {
  return inRequest(appPool, driver, async (tx) => {
    const trips = await tx.query<{
      trip_id: string;
      seq: number;
      order_code: string;
      type_label: string;
      volume_l: number;
      client_name: string;
      contact_name: string | null;
      phone_enc: string | null;
      site_label: string | null;
      address_enc: string | null;
      zone_name: string | null;
      truck_code: string;
      load_min: number;
      bl_no: string | null;
      steps: { step: string; at: string }[];
      loading_started_at: Date | null;
      unloaded_l: number | null;
    }>('select * from public.driver_trips($1)', [date]);
    const ins = await tx.query<{
      id: string;
      trip_id: string;
      kind: DriverInstruction['kind'];
      address_enc: string | null;
      map_url: string | null;
      note: string | null;
      join_truck_code: string | null;
      created_at: Date;
      acknowledged_at: Date | null;
    }>('select * from public.driver_instructions()');
    const photoRows = await tx.query<{ trip_id: string; n: number }>(
      'select trip_id, n from public.driver_bl_photo_counts($1)',
      [date],
    );
    const photos = new Map(photoRows.rows.map((r) => [r.trip_id, r.n]));
    const plantPhones = new Map(
      (
        await tx.query<{ trip_id: string; phone: string }>(
          'select trip_id, phone from public.driver_plant_phones($1)',
          [date],
        )
      ).rows.map((r) => [r.trip_id, r.phone]),
    );
    // the shared status of the day's rotations (the database scopes it to this driver's own)
    const stageRes = await tx.query<{
      trip_id: string;
      step: StageRow['stage'];
      at: Date;
      source: StageSource;
      implicit: boolean;
      client_time: Date | null;
      corrected_at: Date | null;
      load_linked: boolean;
      confirmed_at: Date | null;
    }>('select * from public.trip_stages($1)', [date]);
    const stageRows = new Map<string, StageRow[]>();
    for (const r of stageRes.rows) {
      const list = stageRows.get(r.trip_id) ?? [];
      list.push({
        stage: r.step,
        at: r.at.toISOString(),
        source: r.source,
        implicit: r.implicit,
        clientTime: r.client_time?.toISOString() ?? null,
        correctedAt: r.corrected_at?.toISOString() ?? null,
        loadLinked: r.load_linked,
        confirmedAt: r.confirmed_at?.toISOString() ?? null,
      });
      stageRows.set(r.trip_id, list);
    }
    // A redirect decided by the office on a cancelled or stopped load (R6, REQUIREMENTS-V1 §8) reaches the driver as one more
    // instruction: the new address, the map link, and an acknowledgement that is recorded on the case.
    const redirects = await tx.query<{
      case_id: string;
      trip_id: string;
      address_enc: string | null;
      acknowledged: boolean;
    }>('select case_id, trip_id, address_enc, acknowledged from public.driver_redirects()');
    // the office number (the company profile's phone; the only phone setting there is, and no plant has one): a tel: link, none when unset
    const officePhone =
      (await tx.query<{ p: string | null }>('select public.company_contact_phone() as p')).rows[0]?.p ?? null;
    return {
      officePhone,
      trips: trips.rows.map((r) => {
        const address = cipher.open(r.address_enc);
        const status = deriveStages(stageRows.get(r.trip_id) ?? []);
        // the effective time of each recorded stage (a correction's when there is one)
        const steps = Object.fromEntries(
          status.stages.filter((s) => s.at).map((s) => [s.stage, s.at as string]),
        );
        return {
          id: r.trip_id,
          seq: r.seq,
          orderCode: r.order_code,
          typeLabel: r.type_label,
          volumeL: r.volume_l,
          clientName: r.client_name,
          contactName: r.contact_name,
          phone: cipher.open(r.phone_enc),
          siteLabel: r.site_label,
          address,
          mapUrl: mapLink(address),
          zoneName: r.zone_name,
          truckCode: r.truck_code,
          loadMin: r.load_min,
          blNo: r.bl_no,
          loadingStartedAt: steps['loading_started'] ?? r.loading_started_at?.toISOString() ?? null,
          steps,
          stages: status.stages,
          stage: emergencyStage(steps),
          unloadedL: r.unloaded_l,
          blPhotos: photos.get(r.trip_id) ?? 0,
          plantPhone: plantPhones.get(r.trip_id) ?? null,
        };
      }),
      instructions: [
        ...redirects.rows.map((r): DriverInstruction => {
          const address = cipher.open(r.address_enc);
          return {
            id: r.case_id,
            tripId: r.trip_id,
            kind: 'redirect',
            address,
            mapUrl: mapLink(address),
            note: null,
            joinTruckCode: null,
            createdAt: new Date(0).toISOString(),
            acknowledgedAt: r.acknowledged ? new Date(0).toISOString() : null,
          };
        }),
        ...ins.rows.map((i): DriverInstruction => {
          const address = cipher.open(i.address_enc);
          return {
            id: i.id,
            tripId: i.trip_id,
            kind: i.kind,
            address,
            mapUrl: mapLinksOn() ? (i.map_url ?? mapLink(address)) : null,
            note: i.note,
            joinTruckCode: i.join_truck_code,
            createdAt: i.created_at.toISOString(),
            acknowledgedAt: i.acknowledged_at?.toISOString() ?? null,
          };
        }),
      ],
    };
  });
}

const actionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('step'),
    key: z.string().min(8).max(80),
    tripId: z.uuid(),
    step: z.string(),
    at: z.iso.datetime(),
    volumeL: z.number().int().min(1).max(100_000).optional(),
    reason: z.enum(['traffic', 'site_wait', 'breakdown', 'other']).optional(),
  }),
  z.object({
    kind: z.literal('emergency'),
    key: z.string().min(8).max(80),
    tripId: z.uuid(),
    option: z.string(),
    at: z.iso.datetime(),
    pctUnloaded: z.number().int().min(0).max(100).optional(),
    note: z.string().max(300).optional(),
  }),
  z.object({
    kind: z.literal('pump'),
    key: z.string().min(8).max(80),
    jobId: z.uuid(),
    step: z.string(),
    at: z.iso.datetime(),
    m3: z.number().int().min(1).max(500).optional(),
  }),
  z.object({
    kind: z.literal('ack'),
    key: z.string().min(8).max(80),
    instructionId: z.uuid(),
    at: z.iso.datetime(),
  }),
]);

function outcomeOf(key: string, error: unknown): SyncOutcome {
  const e = error as { code?: string; message?: string };
  const m = e.message ?? '';
  // The plant has not recorded the load yet: the tap is kept and sent again later.
  if (/previous step is not recorded/.test(m))
    return { key, status: 'rejected', code: 'wait_previous', retry: true };
  if (e.code === '23505') return { key, status: 'replayed' };
  if (e.code === '42501') return { key, status: 'rejected', code: 'forbidden', retry: false };
  if (e.code === '23514') return { key, status: 'rejected', code: 'invalid', retry: false };
  if (e.code === '22P02' || e.code === '23503')
    return { key, status: 'rejected', code: 'unknown', retry: false };
  throw error;
}

/**
 * Applies the phone's queued taps in order, each in its own transaction so one refusal does not block the rest. A key stored once
 * is never stored twice, so the same batch may be sent again after a lost answer.
 */
export async function syncActions(
  appPool: pg.Pool,
  driver: SessionUser,
  actions: unknown,
  /** The server's instant (the application's clock): the stage is stamped with it; the phone's time of the tap is kept apart. */
  deps: { now?: Date } = {},
): Promise<Result<SyncOutcome[], 'INVALID' | 'SESSION_ENDED'>> {
  const parsed = z.array(actionSchema).max(200).safeParse(actions);
  if (!parsed.success) return err('INVALID');
  const out: SyncOutcome[] = [];
  for (const a of parsed.data as QueueAction[]) {
    try {
      const status = await inRequest(appPool, driver, async (tx): Promise<'recorded' | 'replayed'> => {
        if (a.kind === 'step') {
          const r = await tx.query<{ r: 'recorded' | 'replayed' }>(
            'select public.driver_report($1, $2, $3, $4, $5, $6, $7) as r',
            [a.tripId, a.step, a.at, a.key, a.volumeL ?? null, a.reason ?? null, deps.now ?? null],
          );
          return r.rows[0]?.r ?? 'recorded';
        }
        if (a.kind === 'emergency') {
          const r = await tx.query<{ r: 'recorded' | 'replayed' }>(
            'select public.driver_emergency($1, $2, $3, $4, $5, $6) as r',
            [a.tripId, a.option, a.pctUnloaded ?? null, a.note ?? null, a.key, a.at],
          );
          return r.rows[0]?.r ?? 'recorded';
        }
        if (a.kind === 'pump') {
          const r = await tx.query<{ r: 'recorded' | 'replayed' }>(
            'select public.pump_report($1, $2, $3, $4, $5) as r',
            [a.jobId, a.step, a.at, a.key, a.m3 ?? null],
          );
          return r.rows[0]?.r ?? 'recorded';
        }
        // The id is a redirect case of the cancellation flow (R6) or an instruction of the emergency flow: the case is tried first,
        // and a case already acknowledged is a replay.
        const redirect = await tx.query<{ ok: boolean }>('select public.driver_ack_redirect($1) as ok', [
          a.instructionId,
        ]);
        if (redirect.rows[0]?.ok) return 'recorded';
        const known = await tx.query('select 1 from public.driver_redirects() where case_id = $1', [
          a.instructionId,
        ]);
        if (known.rowCount) return 'replayed';
        await tx.query('select public.driver_ack($1)', [a.instructionId]);
        return 'recorded';
      });
      out.push({ key: a.key, status });
    } catch (error) {
      // R18-05: the session ended between two transactions of the batch (the database fence refused this one): the REST of the batch is not applied
      // and not answered as rejected: the phone keeps its queue and sends it again after the next sign-in (every key is idempotent).
      if (/field_session: ended/.test((error as { message?: string }).message ?? ''))
        return err('SESSION_ENDED');
      out.push(outcomeOf(a.key, error));
    }
  }
  return ok(out);
}

export interface PumpJobView {
  id: string;
  pumpCode: string;
  clientName: string | null;
  siteLabel: string;
  address: string | null;
  mapUrl: string | null;
  plannedM3: number | null;
  steps: string[];
  m3Pumped: number | null;
}

export async function getPumpDay(
  appPool: pg.Pool,
  operator: SessionUser,
  date: string,
  cipher: FieldCipher,
): Promise<PumpJobView[]> {
  const { rows } = await inRequest(appPool, operator, (tx) =>
    tx.query<{
      job_id: string;
      pump_code: string;
      client_name: string | null;
      site_label: string;
      address_enc: string | null;
      planned_m3: number | null;
      steps: { step: string }[];
      m3_pumped: number | null;
    }>('select * from public.pump_jobs($1)', [date]),
  );
  return rows.map((r) => {
    const address = cipher.open(r.address_enc);
    return {
      id: r.job_id,
      pumpCode: r.pump_code,
      clientName: r.client_name,
      siteLabel: r.site_label,
      address,
      mapUrl: mapLink(address),
      plannedM3: r.planned_m3,
      steps: r.steps.map((s) => s.step),
      m3Pumped: r.m3_pumped,
    };
  });
}

// ---- the office side ----

export interface OpenEmergency {
  id: string;
  tripId: string;
  step: string;
  option: string;
  pctUnloaded: number | null;
  note: string | null;
  at: string;
  driverName: string;
  truckCode: string;
  orderCode: string;
  clientName: string;
  siteLabel: string | null;
  volumeL: number;
  resolvedAt: string | null;
}

/** The emergencies of the day and the last day's: who, where, at which step. Quantities and names, no price. */
export async function listEmergencies(appPool: pg.Pool, actor: SessionUser): Promise<OpenEmergency[]> {
  await require(appPool, actor, 'field.emergencies');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      trip_id: string;
      step: string;
      option: string;
      pct_unloaded: number | null;
      note: string | null;
      at: Date;
      driver_name: string;
      truck_code: string;
      order_code: string;
      client_name: string;
      site_label: string | null;
      volume_l: number;
      resolved_at: Date | null;
    }>('select * from public.emergencies_open()'),
  );
  return rows.map((r) => ({
    id: r.id,
    tripId: r.trip_id,
    step: r.step,
    option: r.option,
    pctUnloaded: r.pct_unloaded,
    note: r.note,
    at: r.at.toISOString(),
    driverName: r.driver_name,
    truckCode: r.truck_code,
    orderCode: r.order_code,
    clientName: r.client_name,
    siteLabel: r.site_label,
    volumeL: r.volume_l,
    resolvedAt: r.resolved_at?.toISOString() ?? null,
  }));
}

const instructSchema = z
  .object({
    emergencyId: z.uuid(),
    kind: z.enum(['continue', 'extra_load', 'redirect', 'join']),
    address: z.string().trim().max(300).optional(),
    mapUrl: z.string().url().startsWith('https://').max(500).optional(),
    note: z.string().trim().max(300).optional(),
    joinTripId: z.uuid().optional(),
  })
  .refine((v) => v.kind !== 'redirect' || v.address || v.mapUrl)
  .refine((v) => v.kind !== 'join' || v.joinTripId);

/** The office tells the driver what to do next. A redirect carries the new address (sealed) and/or a map link; the driver acknowledges. */
export async function instructDriver(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  cipher: FieldCipher,
): Promise<Result<{ id: string }, 'INVALID' | 'NOT_FOUND'>> {
  await require(appPool, actor, 'field.instruct');
  const parsed = instructSchema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  const v = parsed.data;
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>('select public.emergency_instruct($1, $2, $3, $4, $5, $6) as id', [
        v.emergencyId,
        v.kind,
        v.address ? cipher.seal(v.address) : null,
        v.mapUrl ?? null,
        v.note ?? null,
        v.joinTripId ?? null,
      ]),
    );
    return ok({ id: rows[0]?.id as string });
  } catch (error) {
    const e = error as { code?: string };
    if (e.code === '23514' || e.code === '22P02' || e.code === '23503') return err('NOT_FOUND');
    throw error;
  }
}

/** Plans a pump job for an operator. */
export async function createPumpJob(
  appPool: pg.Pool,
  actor: SessionUser,
  input: {
    date: string;
    pumpId: string;
    operatorId: string;
    clientId?: string | null;
    siteLabel: string;
    address?: string | null;
    plannedM3?: number | null;
  },
  cipher: FieldCipher,
): Promise<Result<{ id: string }, 'INVALID'>> {
  await require(appPool, actor, 'field.pump_plan');
  const ok_ =
    /^\d{4}-\d{2}-\d{2}$/.test(input.date) &&
    z.uuid().safeParse(input.pumpId).success &&
    z.uuid().safeParse(input.operatorId).success &&
    input.siteLabel.trim().length >= 1 &&
    input.siteLabel.trim().length <= 120;
  if (!ok_) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>('select public.create_pump_job($1, $2, $3, $4, $5, $6, $7) as id', [
        input.date,
        input.pumpId,
        input.operatorId,
        input.clientId ?? null,
        input.siteLabel,
        input.address ? cipher.seal(input.address) : null,
        input.plannedM3 ?? null,
      ]),
    );
    return ok({ id: rows[0]?.id as string });
  } catch (error) {
    const e = error as { code?: string };
    if (e.code === '23514' || e.code === '23503' || e.code === '22P02') return err('INVALID');
    throw error;
  }
}
