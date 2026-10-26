import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import type { FileStore } from '@/lib/files/store';
import { type UploadError, validateUpload } from '@/lib/files/validate-upload';
import {
  inRequest,
  isMalformedId,
  isUniqueViolation,
  recordAuditEvent,
  require,
  type SessionUser,
} from '@/modules/platform-security';
import { parseBlReturnInput } from '../domain/load-input';
import { type DeliveryError, deliveryFailure } from './delivery-service';
import { opsParameter } from './ops-parameters';

export type ScanError = DeliveryError | UploadError | 'NO_RETURN' | 'ALREADY_HAS_SCAN';

/** What a browser sent: the type it declared and the bytes. Both are checked here, never trusted. */
export interface ScanUpload {
  declaredType: string;
  bytes: Uint8Array;
}

/**
 * The scan of a signed BL, in the caller's transaction: checked (type, magic bytes, size, metadata stripped), the row first
 * (the database refuses a BL without its signed return, a cancelled load, a second scan), then the sealed bytes. If sealing
 * fails the transaction rolls back; a sealed file whose commit fails is unreachable (no row names it).
 */
async function insertScan(
  tx: pg.PoolClient,
  actor: SessionUser,
  deliveryId: string,
  upload: ScanUpload,
  store: FileStore,
): Promise<Result<{ id: string }, ScanError>> {
  const checked = validateUpload({
    declaredType: upload.declaredType,
    bytes: upload.bytes,
    maxBytes: await opsParameter(tx, 'upload_max_bytes'),
  });
  if (!checked.ok) return err(checked.error);
  const id = randomUUID();
  await tx.query(
    `insert into delivery_file (id, delivery_id, content_type, size_bytes, sha256, uploaded_by)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      deliveryId,
      checked.value.type,
      checked.value.bytes.length,
      createHash('sha256').update(checked.value.bytes).digest('hex'),
      actor.id,
    ],
  );
  await store.put(id, checked.value.bytes);
  return ok({ id });
}

function scanFailure(error: unknown): ScanError {
  const e = error as { code?: string; message?: string };
  if (e.code === '23514' && /signed return is not recorded/.test(e.message ?? '')) return 'NO_RETURN';
  if (isUniqueViolation(error) && /delivery_file/.test((error as { constraint?: string }).constraint ?? ''))
    return 'ALREADY_HAS_SCAN';
  return deliveryFailure(error);
}

const deliveryIdSchema = z.object({ deliveryId: z.uuid() });

/** Adds the scan to a BL whose signed return is recorded (AC-INT-02). Once per BL. */
export async function attachDeliveryScan(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  upload: ScanUpload,
  deps: { store: FileStore },
): Promise<Result<{ id: string }, ScanError>> {
  await require(appPool, actor, 'delivery_files.write');
  const parsed = deliveryIdSchema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  try {
    return await inRequest(appPool, actor, (tx) =>
      insertScan(tx, actor, parsed.data.deliveryId, upload, deps.store),
    );
  } catch (error) {
    return err(scanFailure(error));
  }
}

/**
 * The signed BL comes back, with its scan when there is one, in one transaction: nothing is recorded if the file is refused
 * (the person fixes the file and tries again). A second recording learns who and when, as `recordBlReturn` does.
 */
export async function recordBlReturnWithScan(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  upload: ScanUpload | null,
  deps: { store: FileStore },
): Promise<
  Result<{ id: string; scanId: string | null }, ScanError> | { ok: false; error: 'ALREADY_RETURNED' }
> {
  await require(appPool, actor, 'deliveries.bl_return');
  if (upload) await require(appPool, actor, 'delivery_files.write');
  const parsed = parseBlReturnInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  const id = randomUUID();
  try {
    return await inRequest(
      appPool,
      actor,
      async (tx): Promise<Result<{ id: string; scanId: string | null }, ScanError>> => {
        await tx.query(
          `insert into delivery_return (id, delivery_id, returned_on, returned_volume_l, created_by) values ($1, $2, $3, $4, $5)`,
          [id, v.deliveryId, v.returnedOn, v.returnedVolumeL, actor.id],
        );
        if (!upload) return ok({ id, scanId: null });
        const scan = await insertScan(tx, actor, v.deliveryId, upload, deps.store);
        if (!scan.ok) {
          // A refused file leaves nothing behind: the whole entry is rolled back.
          throw new ScanRefused(scan.error);
        }
        return ok({ id, scanId: scan.value.id });
      },
    );
  } catch (error) {
    if (error instanceof ScanRefused) return err(error.reason);
    if (isUniqueViolation(error)) return { ok: false, error: 'ALREADY_RETURNED' };
    return err(scanFailure(error));
  }
}

class ScanRefused extends Error {
  readonly reason: ScanError;
  constructor(reason: ScanError) {
    super(reason);
    this.reason = reason;
  }
}

export interface OpenedScan {
  blNo: string;
  contentType: string;
  bytes: Buffer;
}

/**
 * The scan of a BL for download: found through the caller's own row-level security (a role that cannot read it gets
 * NOT_FOUND), the view audited first, then decrypted; a file that no longer matches its recorded hash is refused.
 */
export async function openDeliveryScan(
  appPool: pg.Pool,
  actor: SessionUser,
  deliveryId: string,
  deps: { store: FileStore },
): Promise<Result<OpenedScan, 'NOT_FOUND' | 'CORRUPT'>> {
  await require(appPool, actor, 'delivery_files.read');
  const parsed = deliveryIdSchema.safeParse({ deliveryId });
  if (!parsed.success) return err('NOT_FOUND');
  try {
    return await inRequest(
      appPool,
      actor,
      async (tx): Promise<Result<OpenedScan, 'NOT_FOUND' | 'CORRUPT'>> => {
        const { rows } = await tx.query<{ id: string; content_type: string; sha256: string; bl_no: string }>(
          `select f.id, f.content_type, f.sha256, d.bl_no
           from delivery_file f join delivery d on d.id = f.delivery_id where f.delivery_id = $1`,
          [parsed.data.deliveryId],
        );
        const row = rows[0];
        if (!row) return err('NOT_FOUND');
        await recordAuditEvent(tx, { action: 'view', table: `file:bl_scan:${row.bl_no}`, rowId: row.id });
        // A file altered on disk, moved under another id, or sealed with a key that is gone does not open.
        const bytes = await deps.store.get(row.id).catch(() => null);
        if (!bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256) return err('CORRUPT');
        return ok({ blNo: row.bl_no, contentType: row.content_type, bytes });
      },
    );
  } catch (error) {
    if (isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}
