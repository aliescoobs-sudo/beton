import { formatCentimes } from '@/lib/money';
import { err, ok } from '@/lib/result';
import { type InstrumentError, parseReceiveInput, receiveInstrument } from '@/modules/ledger';
import { asDryRun, can } from '@/modules/platform-security';
import { recordPaymentParams, type StoredDraft } from '../../domain/drafts';
import { clientByCode } from './resolve';
import type { DraftError, DraftTool, ExecContext, Prepared } from './types';

type Payment = Extract<StoredDraft, { action: 'record_payment' }>;

const mapError = (e: InstrumentError): DraftError =>
  e === 'NOT_FOUND' ? 'NOT_FOUND' : e === 'NOTHING_TO_ALLOCATE' ? 'STALE' : 'INVALID';

async function receiveInput(ctx: ExecContext, d: Payment) {
  const client = await clientByCode(ctx, d.client);
  if (!client) return null;
  const input = {
    clientId: client.id,
    method: d.method,
    amountCentimes: d.amountCentimes,
    number: d.number,
    bank: null,
    writtenDate: d.writtenDate,
    orderCode: d.orderCode,
    // No order named: the payment is spread over the client's open invoices, oldest due date first, by the database.
    allocateToClient: d.orderCode ? null : true,
  };
  return parseReceiveInput(input).ok ? { client, input } : null;
}

export const recordPayment: DraftTool<typeof recordPaymentParams> = {
  name: 'record_payment',
  kind: 'draft',
  description:
    'Prepares the recording of a payment received from a client (code): method (cash, cheque, lcn, transfer), the amount and the number of a cheque or LCN as the references of the question, the written date of a cheque or LCN, optionally the order code it is for. Allocation to the open invoices is done by code, oldest due first. The person checks and confirms.',
  params: recordPaymentParams,
  roles: ['owner', 'office'],
  permissions: ['instruments.write'],
  async prepare(ctx, a) {
    const amount = ctx.ps.userAmount(a.amount);
    if (typeof amount !== 'number' || amount <= 0) return err('NEEDS_AMOUNT');
    const number = a.number === undefined ? null : (ctx.ps.userNumber(a.number) ?? null);
    const paper = a.method === 'cheque' || a.method === 'lcn';
    if (paper && (number === null || a.written_date === undefined)) return err('INCOMPLETE');
    const stored: Payment = {
      action: 'record_payment',
      client: a.client,
      method: a.method,
      amountCentimes: amount,
      number: a.method === 'cash' ? null : number,
      writtenDate: paper ? (a.written_date ?? null) : null,
      orderCode: a.order_code ?? null,
    };
    const resolved = await receiveInput(ctx, stored);
    if (!resolved) return err('NOT_FOUND');
    const money = can(ctx.actor.role, 'orders.read_money');
    // The rehearsal: the real service, rolled back. It tells whether the entry is possible and, for the roles that read money,
    // what it would cover. Office is told nothing of money, as on the form.
    const rehearsal = await asDryRun(() =>
      receiveInstrument(ctx.appPool, ctx.actor, resolved.input, { today: ctx.today }),
    );
    if (!rehearsal.ok) return err(mapError(rehearsal.error));
    const covered = rehearsal.value.effects?.find(
      (e) => e.kind === 'receivable_spread' || e.kind === 'receivable_covered',
    );
    const card: Prepared['card'] = {
      action: 'record_payment',
      needsStepUp: true,
      blind: !money,
      fields: [
        { key: 'client', value: resolved.client.name },
        { key: 'method', value: stored.method, enumOf: 'method' },
        ...(stored.number ? [{ key: 'number', value: stored.number, ltr: true }] : []),
        ...(stored.writtenDate ? [{ key: 'writtenDate', value: stored.writtenDate, ltr: true }] : []),
        ...(stored.orderCode ? [{ key: 'order', value: stored.orderCode, ltr: true }] : []),
        ...(money
          ? [
              { key: 'amount', value: `${formatCentimes(stored.amountCentimes)} MAD` },
              {
                key: 'covers',
                value: `${formatCentimes(covered && 'amountCentimes' in covered ? covered.amountCentimes : 0)} MAD`,
              },
            ]
          : []),
      ],
      rows: [],
      notes: money ? ['checkAmount', 'allocationOldestFirst'] : ['checkAmountOnForm'],
    };
    return ok({ stored, card });
  },
  async execute(ctx, stored) {
    if (stored.action !== 'record_payment') return err('INVALID');
    const resolved = await receiveInput(ctx, stored);
    if (!resolved) return err('STALE');
    const made = await receiveInstrument(ctx.appPool, ctx.actor, resolved.input, { today: ctx.today });
    return made.ok ? ok({ ref: stored.number }) : err(mapError(made.error));
  },
};
