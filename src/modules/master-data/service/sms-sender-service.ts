import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import type { SessionUser } from '@/modules/platform-security';
import {
  maskPhone,
  normalizePhoneE164,
  phoneLookupHash,
  SMS_SENDER_END_REASONS,
  SMS_SENDER_REASONS,
} from '../domain/sms-phone';
import { defaultFieldCipher, type FieldCipher } from './field-cipher';
import { inRequest, isMalformedId, require } from './request';

export type SmsSenderError = 'INVALID' | 'NOT_ALLOWED' | 'NUMBER_IN_USE';

export interface SmsSenderDeps {
  /** LOOKUP_HMAC_KEY (base64). */
  hmacKey: string;
  cipher?: FieldCipher;
}

const registerSchema = z.object({
  phone: z.string().min(5).max(40),
  driverId: z.uuid(),
  truckId: z.uuid().nullable().default(null),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.enum(SMS_SENDER_REASONS),
  note: z.string().trim().max(300).nullable().default(null),
});

export interface SmsSender {
  id: string;
  /** The last three digits only; the clear number is never returned. */
  phoneMasked: string;
  driverId: string;
  driverName: string;
  truckId: string | null;
  truckCode: string | null;
  validFrom: string;
  validTo: string | null;
  reason: string;
}

function failure(error: unknown): SmsSenderError {
  const e = error as { code?: string };
  if (e.code === '23505') return 'NUMBER_IN_USE';
  if (e.code === '42501') return 'NOT_ALLOWED';
  if (e.code === '23514' || e.code === '23502' || isMalformedId(error)) return 'INVALID';
  throw error;
}

/** Owner and app_admin register a number for a driver: the number is sealed and hashed here, the door checks the whole tuple. */
export async function registerSmsSender(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: SmsSenderDeps,
): Promise<Result<{ id: string }, SmsSenderError>> {
  await require(appPool, actor, 'sms.sender.manage');
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  const v = parsed.data;
  const e164 = normalizePhoneE164(v.phone);
  if (e164 === null) return err('INVALID');
  const sealed = (deps.cipher ?? defaultFieldCipher()).seal(e164);
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>('select public.register_sms_sender($1, $2, $3, $4, $5, $6, $7) as id', [
        phoneLookupHash(deps.hmacKey, e164),
        sealed,
        v.driverId,
        v.truckId,
        v.validFrom,
        v.reason,
        v.note,
      ]),
    );
    return ok({ id: rows[0]!.id });
  } catch (error) {
    return err(failure(error));
  }
}

export async function endSmsSender(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { id: string; validTo: string; reason: (typeof SMS_SENDER_END_REASONS)[number] },
): Promise<Result<true, SmsSenderError>> {
  await require(appPool, actor, 'sms.sender.manage');
  if (!SMS_SENDER_END_REASONS.includes(input.reason)) return err('INVALID');
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query('select public.end_sms_sender($1, $2, $3)', [input.id, input.validTo, input.reason]),
    );
    return ok(true);
  } catch (error) {
    return err(failure(error));
  }
}

export async function listSmsSenders(
  appPool: pg.Pool,
  actor: SessionUser,
  deps: { cipher?: FieldCipher } = {},
): Promise<SmsSender[]> {
  await require(appPool, actor, 'sms.sender.manage');
  const cipher = deps.cipher ?? defaultFieldCipher();
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      o_id: string;
      o_phone_enc: string;
      o_driver_id: string;
      o_driver_name: string;
      o_truck_id: string | null;
      o_truck_code: string | null;
      o_valid_from: string;
      o_valid_to: string | null;
      o_reason_code: string;
    }>(`select o_id, o_phone_enc, o_driver_id, o_driver_name, o_truck_id, o_truck_code,
               to_char(o_valid_from, 'YYYY-MM-DD') as o_valid_from, to_char(o_valid_to, 'YYYY-MM-DD') as o_valid_to, o_reason_code
          from public.sms_senders_list()`),
  );
  return rows.map((r) => ({
    id: r.o_id,
    phoneMasked: maskPhone(cipher.open(r.o_phone_enc) ?? ''),
    driverId: r.o_driver_id,
    driverName: r.o_driver_name,
    truckId: r.o_truck_id,
    truckCode: r.o_truck_code,
    validFrom: r.o_valid_from,
    validTo: r.o_valid_to,
    reason: r.o_reason_code,
  }));
}

/** The optional GPS unit of a vehicle (an explicit mapping; an unmapped unit is never assigned). Owner and app_admin. */
export async function setTruckGpsUnit(
  appPool: pg.Pool,
  actor: SessionUser,
  truckId: string,
  unitId: string | null,
): Promise<Result<true, 'INVALID' | 'DUPLICATE'>> {
  await require(appPool, actor, 'sms.sender.manage');
  const unit = unitId === null ? null : unitId.trim();
  if (unit !== null && (unit.length < 1 || unit.length > 40)) return err('INVALID');
  try {
    const { rowCount } = await inRequest(appPool, actor, (tx) =>
      tx.query('update truck set gps_unit_id = $2 where id = $1', [truckId, unit]),
    );
    return rowCount === 1 ? ok(true) : err('INVALID');
  } catch (error) {
    const e = error as { code?: string };
    if (e.code === '23505') return err('DUPLICATE');
    if (isMalformedId(error)) return err('INVALID');
    throw error;
  }
}
