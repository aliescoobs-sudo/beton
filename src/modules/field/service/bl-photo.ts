import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { FileStore } from '@/lib/files/store';
import { validateUpload } from '@/lib/files/validate-upload';
import { err, ok, type Result } from '@/lib/result';
import {
  inRequest,
  isMalformedId,
  recordAuditEvent,
  require,
  type SessionUser,
} from '@/modules/platform-security';

// C3 (REQUIREMENTS-V1 §7 step 5): the optional photo of the signed BL, taken on the driver's phone. The row is written by one
// database door (the driver of the rotation, after the unloading is reported); the checked bytes, with their metadata (GPS)
// removed, are sealed in the file store in the same request. If sealing fails the transaction rolls back: no row without a file.

/** Photos only (a phone camera), at most 8 MB after the phone's own resize. */
export const BL_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type BlPhotoError =
  | 'INVALID'
  | 'TYPE_NOT_ALLOWED'
  | 'TOO_LARGE'
  | 'EMPTY'
  | 'CORRUPT'
  | 'NOT_YOUR_ROTATION'
  | 'NOT_UNLOADED'
  | 'TOO_MANY';

const inputSchema = z.object({
  tripId: z.uuid(),
  key: z.string().min(8).max(80),
  takenAt: z.iso.datetime(),
});

export interface PhotoUpload {
  declaredType: string;
  bytes: Uint8Array;
}

export async function attachDriverBlPhoto(
  appPool: pg.Pool,
  driver: SessionUser,
  input: unknown,
  upload: PhotoUpload,
  deps: { store: FileStore },
): Promise<Result<{ status: 'recorded' | 'replayed' }, BlPhotoError>> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  const declared = upload.declaredType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!PHOTO_TYPES.has(declared)) return err('TYPE_NOT_ALLOWED');
  const checked = validateUpload({
    declaredType: upload.declaredType,
    bytes: upload.bytes,
    maxBytes: BL_PHOTO_MAX_BYTES,
  });
  if (!checked.ok)
    return err(checked.error === 'TYPE_MISMATCH' ? 'CORRUPT' : (checked.error as BlPhotoError));
  const id = randomUUID();
  try {
    return await inRequest(appPool, driver, async (tx) => {
      const door = await tx.query<{ s: 'recorded' | 'replayed' }>(
        'select public.driver_attach_bl_photo($1, $2, $3, $4, $5, $6, $7) as s',
        [
          parsed.data.tripId,
          id,
          checked.value.type,
          checked.value.bytes.length,
          createHash('sha256').update(checked.value.bytes).digest('hex'),
          parsed.data.takenAt,
          parsed.data.key,
        ],
      );
      const status = door.rows[0]?.s ?? 'recorded';
      // A replay stored nothing new, so there is nothing to seal.
      if (status === 'recorded') await deps.store.put(id, checked.value.bytes);
      return ok({ status });
    });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    const m = e.message ?? '';
    if (/not your rotation|not a driver/.test(m)) return err('NOT_YOUR_ROTATION');
    if (/unloading is not reported/.test(m)) return err('NOT_UNLOADED');
    if (/at most three/.test(m)) return err('TOO_MANY');
    if (/not credible/.test(m) || isMalformedId(error)) return err('INVALID');
    throw error;
  }
}

/** The driver's day: how many photos each rotation has (a tick on the phone, never the files). */
export async function blPhotoCounts(
  appPool: pg.Pool,
  driver: SessionUser,
  date: string,
): Promise<Record<string, number>> {
  const { rows } = await inRequest(appPool, driver, (tx) =>
    tx.query<{ trip_id: string; n: number }>('select trip_id, n from public.driver_bl_photo_counts($1)', [
      date,
    ]),
  );
  return Object.fromEntries(rows.map((r) => [r.trip_id, r.n]));
}

export interface TripBlPhoto {
  id: string;
  tripId: string;
  orderCode: string;
  seq: number;
  takenAt: string;
}

/** The photos the drivers sent for the rotations of a day: offices, owner roles, plant (own plant) and support. */
export async function listTripBlPhotos(
  appPool: pg.Pool,
  actor: SessionUser,
  date: string,
): Promise<TripBlPhoto[]> {
  await require(appPool, actor, 'driver_bl_photos.read');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string; trip_id: string; seq: number; taken_at: Date; order_code: string }>(
        `select id, trip_id, seq, taken_at, order_code from driver_bl_photo where trip_date = $1 order by order_code, seq`,
        [date],
      ),
    );
    return rows.map((r) => ({
      id: r.id,
      tripId: r.trip_id,
      orderCode: r.order_code,
      seq: r.seq,
      takenAt: r.taken_at.toISOString(),
    }));
  } catch (error) {
    if (isMalformedId(error)) return [];
    throw error;
  }
}

export interface OpenedPhoto {
  contentType: string;
  bytes: Buffer;
  orderCode: string;
}

/** For download: through the caller's own RLS, the view audited, a file that no longer matches its recorded hash refused. */
export async function openDriverBlPhoto(
  appPool: pg.Pool,
  actor: SessionUser,
  photoId: string,
  deps: { store: FileStore },
): Promise<Result<OpenedPhoto, 'NOT_FOUND' | 'CORRUPT'>> {
  await require(appPool, actor, 'driver_bl_photos.read');
  if (!z.uuid().safeParse(photoId).success) return err('NOT_FOUND');
  return inRequest(appPool, actor, async (tx): Promise<Result<OpenedPhoto, 'NOT_FOUND' | 'CORRUPT'>> => {
    const { rows } = await tx.query<{ id: string; content_type: string; sha256: string; code: string }>(
      `select id, content_type, sha256, order_code as code from driver_bl_photo where id = $1`,
      [photoId],
    );
    const row = rows[0];
    if (!row) return err('NOT_FOUND');
    await recordAuditEvent(tx, { action: 'view', table: `file:driver_bl_photo:${row.code}`, rowId: row.id });
    const bytes = await deps.store.get(row.id).catch(() => null);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256) return err('CORRUPT');
    return ok({ contentType: row.content_type, bytes, orderCode: row.code });
  });
}
