import { err, ok } from '@/lib/result';
import { listDeliveries, recordLoss, type LossError } from '@/modules/operations';
import { asDryRun } from '@/modules/platform-security';
import { recordReturnParams, type StoredDraft } from '../../domain/drafts';
import { litresToM3 } from '../../domain/units';
import type { DraftError, DraftTool, ExecContext } from './types';

type Return = Extract<StoredDraft, { action: 'record_return' }>;

const mapError = (e: LossError): DraftError =>
  e === 'NOT_FOUND'
    ? 'NOT_FOUND'
    : e === 'ALREADY_RECORDED'
      ? 'ALREADY_RECORDED'
      : e === 'OVER_LOAD'
        ? 'OVER_LOAD'
        : e === 'NOT_LIVE'
          ? 'STALE'
          : 'INVALID';

async function loadOf(ctx: ExecContext, bl: string) {
  return (
    (await listDeliveries(ctx.appPool, ctx.actor, 500)).find((d) => d.blNo === bl && !d.cancelled) ?? null
  );
}

const lossInput = (deliveryId: string, d: Return) => ({
  deliveryId,
  volumeL: d.volumeL,
  reason: d.reason,
});

/**
 * Concrete that came back or was refused, on its BL, with a reason: the loss record of the screen (`deliveries.loss`). It writes no
 * money: it counts as loss in the consumption report and gives the owner the base of an avoir, which stays his own action.
 */
export const recordReturn: DraftTool<typeof recordReturnParams> = {
  name: 'record_return',
  kind: 'draft',
  description:
    'Prepares the record of concrete brought back or refused on a BL: the BL number, the volume in m³ (the whole load when not given) and the reason. Writes no money. The person checks and confirms.',
  params: recordReturnParams,
  roles: ['owner', 'partner', 'office', 'plant'],
  permissions: ['deliveries.loss'],
  async prepare(ctx, a) {
    const load = await loadOf(ctx, a.bl);
    if (!load) return err('NOT_FOUND');
    if (load.loss) return err('ALREADY_RECORDED');
    const stored: Return = {
      action: 'record_return',
      bl: a.bl,
      volumeL: a.m3 === undefined ? null : Math.round(a.m3 * 1000),
      reason: a.reason,
    };
    if (stored.volumeL !== null && stored.volumeL > load.volumeL) return err('OVER_LOAD');
    const rehearsal = await asDryRun(() => recordLoss(ctx.appPool, ctx.actor, lossInput(load.id, stored)));
    if (!rehearsal.ok) return err(mapError(rehearsal.error));
    return ok({
      stored,
      card: {
        action: 'record_return',
        needsStepUp: false,
        blind: false,
        fields: [
          { key: 'bl', value: load.blNo, ltr: true },
          { key: 'loadVolume', value: `${litresToM3(load.volumeL)} m³`, ltr: true },
          {
            key: 'returnedVolume',
            value: stored.volumeL === null ? 'whole' : `${litresToM3(stored.volumeL)} m³`,
            ltr: stored.volumeL !== null,
            enumOf: stored.volumeL === null ? 'volume' : undefined,
          },
          { key: 'reason', value: stored.reason, enumOf: 'reason' },
        ],
        rows: [],
        notes: ['checkBl', 'noMoney'],
      },
    });
  },
  async execute(ctx, stored) {
    if (stored.action !== 'record_return') return err('INVALID');
    const load = await loadOf(ctx, stored.bl);
    if (!load || load.loss) return err('STALE');
    const made = await recordLoss(ctx.appPool, ctx.actor, lossInput(load.id, stored));
    return made.ok ? ok({ ref: stored.bl }) : err(mapError(made.error));
  },
};
