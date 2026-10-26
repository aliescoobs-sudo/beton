import { formatCentimes } from '@/lib/money';
import { err, ok } from '@/lib/result';
import {
  createInvoice,
  getInvoiceQueue,
  type InvoiceError,
  previewInvoiceFromDeliveries,
} from '@/modules/ledger';
import { asDryRun, can } from '@/modules/platform-security';
import { invoiceFromBlsParams, type StoredDraft } from '../../domain/drafts';
import { litresToM3 } from '../../domain/units';
import { clientByCode } from './resolve';
import type { DraftError, DraftTool, ExecContext, Prepared } from './types';

type FromBls = Extract<StoredDraft, { action: 'invoice_from_bls' }>;

const mapError = (e: InvoiceError): DraftError =>
  e === 'NOTHING_TO_INVOICE' || e === 'NOT_FOUND' ? 'STALE' : 'INVALID';

/**
 * The BLs the draft names, as the invoicing queue of the person lists them for that client: delivered, not invoiced, of that
 * client. A BL that is none of these is not in the queue, so the draft cannot name it.
 */
async function queued(ctx: ExecContext, d: FromBls) {
  const queue = await getInvoiceQueue(ctx.appPool, ctx.actor);
  const client = queue.find((c) => c.clientCode === d.client);
  if (!client) return null;
  const picked = d.bls.map((bl) => client.deliveries.find((x) => x.blNo === bl));
  if (picked.some((x) => x === undefined)) return null;
  return { client, deliveries: picked as NonNullable<(typeof picked)[number]>[] };
}

/**
 * Invoices BLs of one client: the draft of what the invoicing queue does (SPEC-assistant §5, AC-ASSIST-20). The card is the queue's
 * own: for the owner the document as the database would make it (lines grouped by product, advances applied, totals) from a
 * rehearsal that is rolled back; for office the BL numbers, m³ and product, and nothing else. Confirmation is `createInvoice`.
 */
export const invoiceFromBls: DraftTool<typeof invoiceFromBlsParams> = {
  name: 'invoice_from_bls',
  kind: 'draft',
  description:
    "Prepares ONE invoice for BLs (numbers) of one client (code) taken from that client's delivered-not-invoiced list: lines grouped by product, advances applied by the invoice itself, one BL on one invoice. The person checks and confirms.",
  params: invoiceFromBlsParams,
  roles: ['owner', 'office'],
  permissions: ['invoices.write'],
  async prepare(ctx, a) {
    const stored: FromBls = { action: 'invoice_from_bls', client: a.client, bls: [...new Set(a.bl_numbers)] };
    const found = await queued(ctx, stored);
    if (!found) return err('STALE');
    const ids = found.deliveries.map((d) => d.deliveryId);
    const client = await clientByCode(ctx, a.client).catch(() => null);
    const money = can(ctx.actor.role, 'invoices.read');
    const card: Prepared['card'] = {
      action: 'invoice_from_bls',
      needsStepUp: true,
      blind: !money,
      fields: [{ key: 'client', value: client?.name ?? found.client.clientName }],
      rows: [],
      notes: ['checkBls', 'oneBlOneInvoice'],
    };
    if (money) {
      const preview = await previewInvoiceFromDeliveries(ctx.appPool, ctx.actor, ids, { today: ctx.today });
      if (!preview.ok) return err(mapError(preview.error));
      const p = preview.value;
      card.rows = p.groups.map((g) => [
        { key: 'product', value: `${g.typeCode} · ${g.typeLabel}`, ltr: true },
        { key: 'volume', value: `${litresToM3(g.volumeL)} m³`, ltr: true },
        { key: 'unitPrice', value: `${formatCentimes(g.unitPriceHtCentimes)} MAD` },
        { key: 'amountHt', value: `${formatCentimes(g.amountHtCentimes)} MAD` },
        { key: 'bls', value: g.blNos.join(', '), ltr: true },
      ]);
      card.fields.push(
        { key: 'totalHt', value: `${formatCentimes(p.totalHtCentimes)} MAD` },
        { key: 'vat', value: `${formatCentimes(p.totalVatCentimes)} MAD` },
        { key: 'totalTtc', value: `${formatCentimes(p.totalTtcCentimes)} MAD` },
        { key: 'advance', value: `${formatCentimes(p.advanceCentimes)} MAD` },
        { key: 'netToPay', value: `${formatCentimes(p.netToPayCentimes)} MAD` },
      );
    } else {
      // Office: the BLs, m³ and product, as the queue shows them to it. The rehearsal tells only whether it can be done.
      card.rows = found.deliveries.map((d) => [
        { key: 'bl', value: d.blNo, ltr: true },
        { key: 'volume', value: `${litresToM3(d.volumeL)} m³`, ltr: true },
        { key: 'product', value: `${d.typeCode} · ${d.typeLabel}`, ltr: true },
      ]);
      const rehearsal = await asDryRun(() =>
        createInvoice(ctx.appPool, ctx.actor, { deliveryIds: ids }, { today: ctx.today }),
      );
      if (!rehearsal.ok) return err(mapError(rehearsal.error));
    }
    return ok({ stored, card });
  },
  async execute(ctx, stored) {
    if (stored.action !== 'invoice_from_bls') return err('INVALID');
    const found = await queued(ctx, stored);
    if (!found) return err('STALE');
    // The same service as the queue: one invoice for these BLs, grouped by product, advances applied by the database.
    const made = await createInvoice(
      ctx.appPool,
      ctx.actor,
      { deliveryIds: found.deliveries.map((d) => d.deliveryId) },
      { today: ctx.today },
    );
    return made.ok ? ok({ ref: made.value.number }) : err(mapError(made.error));
  },
};
