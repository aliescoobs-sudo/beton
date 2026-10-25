import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import {
  inRequest,
  isMalformedId,
  isUniqueViolation,
  require,
  type SessionUser,
} from '@/modules/platform-security';
import { parseLossInput } from '../domain/load-input';

export type LossError = 'INVALID' | 'NOT_FOUND' | 'ALREADY_RECORDED' | 'OVER_LOAD' | 'NOT_LIVE';

function failure(error: unknown): LossError {
  const e = error as { code?: string; message?: string };
  if (isUniqueViolation(error)) return 'ALREADY_RECORDED';
  if (e.code === '23514') {
    if (/more than the load/.test(e.message ?? '')) return 'OVER_LOAD';
    if (/not a live load/.test(e.message ?? '')) return 'NOT_LIVE';
    return 'INVALID';
  }
  if (e.code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  throw error;
}

export interface RecordedLoss {
  id: string;
  volumeL: number;
}

/**
 * Concrete that came back or was refused, recorded on its load with a reason (AC-OPS-23), once. The volume defaults to the
 * whole load. It gives no components back (the concrete was made) and changes nothing the order bills.
 */
export async function recordLoss(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<RecordedLoss, LossError>> {
  await require(appPool, actor, 'deliveries.loss');
  const parsed = parseLossInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<RecordedLoss, LossError>> => {
      const load = await tx.query<{ volume_l: number }>(
        `select volume_l from delivery where id = $1 and reverses_id is null`,
        [v.deliveryId],
      );
      const l = load.rows[0];
      if (!l) return err('NOT_FOUND');
      const volumeL = v.volumeL ?? l.volume_l;
      const id = randomUUID();
      await tx.query(
        `insert into delivery_loss (id, delivery_id, volume_l, reason, note, created_by) values ($1, $2, $3, $4, $5, $6)`,
        [id, v.deliveryId, volumeL, v.reason, v.note ? v.note : null, actor.id],
      );
      return ok({ id, volumeL });
    });
  } catch (error) {
    return err(failure(error));
  }
}
