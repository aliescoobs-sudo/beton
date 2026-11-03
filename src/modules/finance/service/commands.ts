import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { scale } from '../domain/money';
import { addMonths, validDate } from '../domain/period';
import { financeRequest, type FinanceSession } from './request';
const id = z.uuid(),
  amount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  date = z.string().refine(validDate),
  text = z.string().trim().min(1).max(160);
export const financeCommand = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('configure'),
    enabled: z.boolean(),
    leasingTreatment: z.enum(['expense', 'principal_interest']),
  }),
  z.object({
    action: z.literal('category'),
    code: text.max(40),
    label: text.max(120),
    nature: z.enum(['fixed', 'variable']),
    kind: z.enum(['expense', 'pumping']),
  }),
  z.object({
    action: z.literal('allocation'),
    label: text.max(120),
    weights: z.record(id, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
  }),
  z.object({
    action: z.literal('entry'),
    recurrenceMonths: z.number().int().min(1).max(120).default(1),
    date,
    categoryId: id.optional(),
    plantId: id.optional(),
    allocationId: id.optional(),
    kind: z.enum(['expense', 'pumping']),
    amountCentimes: amount,
    reference: text,
    dueDate: date,
  }),
  z.object({ action: z.literal('reverse'), entryId: id, date, reason: text.max(500) }),
  z.object({
    action: z.literal('obligation'),
    date,
    direction: z.enum(['in', 'out']),
    amountCentimes: amount,
    reference: text,
    label: text,
  }),
  z.object({
    action: z.literal('payment'),
    obligationId: id,
    date,
    amountCentimes: amount,
    accountId: id,
    instrumentId: id.optional(),
    reference: text,
  }),
  z.object({ action: z.literal('link'), obligationId: id, instrumentId: id }),
  z.object({
    action: z.literal('steel'),
    date,
    cashCentimes: amount,
    purchaseCentimes: amount,
    chequeCount: z.number().int().min(1).max(3),
    accountId: id,
    reference: text.max(120),
  }),
  z.object({
    action: z.literal('facility'),
    plantId: id.optional(),
    truckId: id.optional(),
    allocationId: id.optional(),
    kind: z.enum(['bank', 'leasing']),
    label: text.max(120),
    date,
    principalCentimes: amount,
    accountId: id,
    schedule: z
      .array(
        z.object({
          date,
          principalCentimes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          costCentimes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        }),
      )
      .min(1)
      .max(600),
  }),
  z.object({
    action: z.literal('valueFuel'),
    fillId: id,
    pricePerLitreCentimes: amount,
    allocationId: id.optional(),
    reference: text,
  }),
  z.object({
    action: z.literal('valueMaterial'),
    movementId: id,
    priceCentimes: amount,
    priceBaseQty: amount,
    reference: text,
  }),
  z
    .object({
      action: z.literal('transfer'),
      fromAccountId: id,
      toAccountId: id,
      date,
      amountCentimes: amount,
      reference: text,
    })
    .refine((v) => v.fromAccountId !== v.toAccountId),
  z.object({
    action: z.literal('holder'),
    accountId: id,
    holder: z.enum(['owner', 'office', 'company_bank']),
  }),
]);
export type FinanceCommand = z.infer<typeof financeCommand>;
export async function executeFinance(pool: pg.Pool, session: FinanceSession, input: unknown) {
  const v = financeCommand.parse(input),
    actor = session.user;
  return financeRequest(
    pool,
    actor,
    'finance.write',
    async (tx) => {
      const made = randomUUID();
      const insert = async (table: string, columns: string[], values: unknown[]) => {
        const cols = ['id', ...columns, 'created_by'],
          args = [made, ...values, actor.id];
        await tx.query(
          `insert into finance.${table} (${cols.join(',')}) values (${args.map((_, i) => '$' + (i + 1)).join(',')})`,
          args,
        );
      };
      switch (v.action) {
        case 'configure':
          await insert('finance_setting', ['enabled', 'leasing_treatment'], [v.enabled, v.leasingTreatment]);
          break;
        case 'category':
          await insert(
            'finance_category',
            ['code', 'label', 'nature', 'kind'],
            [v.code, v.label, v.nature, v.kind],
          );
          break;
        case 'allocation':
          await insert('finance_allocation', ['label', 'weights'], [v.label, JSON.stringify(v.weights)]);
          break;
        case 'entry': {
          for (let month = 0; month < v.recurrenceMonths; month++) {
            const entryId = month === 0 ? made : randomUUID(),
              reference = v.recurrenceMonths === 1 ? v.reference : `${v.reference}:${month + 1}`;
            await tx.query(
              `insert into finance.finance_entry(id,entry_date,category_id,plant_id,allocation_id,kind,amount_centimes,source_ref,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [
                entryId,
                addMonths(v.date, month),
                v.categoryId ?? null,
                v.plantId ?? null,
                v.allocationId ?? null,
                v.kind,
                v.amountCentimes,
                reference,
                actor.id,
              ],
            );
            await tx.query(
              `insert into finance.finance_obligation(id,due_date,direction,amount_centimes,source_ref,entry_id,label,created_by) values($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                randomUUID(),
                addMonths(v.dueDate, month),
                v.kind === 'pumping' ? 'in' : 'out',
                v.amountCentimes,
                'entry:' + entryId,
                entryId,
                reference,
                actor.id,
              ],
            );
          }
          break;
        }
        case 'reverse': {
          const o = (
            await tx.query<{
              kind: string;
              amount_centimes: string;
              category_id: string | null;
              plant_id: string | null;
              allocation_id: string | null;
            }>('select * from finance.finance_entry where id=$1', [v.entryId])
          ).rows[0];
          if (!o) throw new Error('NOT_FOUND');
          // A financial reversal does not undo cash already handed over: a separate refund is explicit.
          await insert(
            'finance_entry',
            [
              'entry_date',
              'category_id',
              'plant_id',
              'allocation_id',
              'kind',
              'amount_centimes',
              'source_ref',
              'reverses_id',
              'reason',
            ],
            [
              v.date,
              o.category_id,
              o.plant_id,
              o.allocation_id,
              o.kind,
              -Number(o.amount_centimes),
              'reversal:' + v.entryId,
              v.entryId,
              v.reason,
            ],
          );
          break;
        }
        case 'obligation':
          await insert(
            'finance_obligation',
            ['due_date', 'direction', 'amount_centimes', 'source_ref', 'label'],
            [v.date, v.direction, v.amountCentimes, v.reference, v.label],
          );
          break;
        case 'payment':
          await insert(
            'finance_payment',
            ['obligation_id', 'payment_date', 'amount_centimes', 'account_id', 'instrument_id', 'reference'],
            [v.obligationId, v.date, v.amountCentimes, v.accountId, v.instrumentId ?? null, v.reference],
          );
          break;
        case 'link':
          await insert(
            'finance_instrument_link',
            ['obligation_id', 'instrument_id'],
            [v.obligationId, v.instrumentId],
          );
          break;
        case 'steel':
          await insert(
            'finance_steel',
            [
              'delivery_date',
              'cash_centimes',
              'purchase_centimes',
              'cheque_count',
              'account_id',
              'reference',
            ],
            [v.date, v.cashCentimes, v.purchaseCentimes, v.chequeCount, v.accountId, v.reference],
          );
          break;
        case 'facility':
          await insert(
            'finance_facility',
            [
              'kind',
              'label',
              'start_date',
              'principal_centimes',
              'account_id',
              'schedule',
              'plant_id',
              'truck_id',
              'allocation_id',
            ],
            [
              v.kind,
              v.label,
              v.date,
              v.principalCentimes,
              v.accountId,
              JSON.stringify(v.schedule),
              v.plantId ?? null,
              v.truckId ?? null,
              v.allocationId ?? null,
            ],
          );
          break;
        case 'valueFuel': {
          const fill = (
            await tx.query<{ data: { id: string; qtyMl: number }[] }>(
              'select finance.source_fuel($1,$2) data',
              ['2000-01-01', '2200-12-31'],
            )
          ).rows[0]!.data.find((f) => f.id === v.fillId);
          if (!fill) throw new Error('NOT_FOUND');
          await insert(
            'finance_fuel_cost',
            [
              'fill_id',
              'amount_centimes',
              'price_per_litre_centimes',
              'allocation_id',
              'valuation_reference',
            ],
            [
              v.fillId,
              scale(fill.qtyMl, v.pricePerLitreCentimes, 1000),
              v.pricePerLitreCentimes,
              v.allocationId ?? null,
              v.reference,
            ],
          );
          break;
        }
        case 'valueMaterial': {
          const source = (
            await tx.query<{ data: { id: string; qtyBase: number }[] }>(
              'select finance.source_consumption($1,$2) data',
              ['2000-01-01', '2200-12-31'],
            )
          ).rows[0]!.data.find((m) => m.id === v.movementId);
          if (!source) throw new Error('NOT_FOUND');
          await insert(
            'finance_material_cost',
            ['movement_id', 'amount_centimes', 'price_centimes', 'price_base_qty', 'valuation_reference'],
            [
              v.movementId,
              scale(-source.qtyBase, v.priceCentimes, v.priceBaseQty),
              v.priceCentimes,
              v.priceBaseQty,
              v.reference,
            ],
          );
          break;
        }
        case 'transfer': {
          for (const [direction, accountId] of [
            ['out', v.fromAccountId],
            ['in', v.toAccountId],
          ] as const) {
            const obligation = randomUUID();
            await tx.query(
              `insert into finance.finance_obligation(id,due_date,direction,amount_centimes,source_ref,label,created_by) values($1,$2,$3,$4,$5,$6,$7)`,
              [
                obligation,
                v.date,
                direction,
                v.amountCentimes,
                'transfer:' + v.reference + ':' + direction,
                v.reference,
                actor.id,
              ],
            );
            await tx.query(
              `insert into finance.finance_payment(id,obligation_id,payment_date,amount_centimes,account_id,reference,created_by) values($1,$2,$3,$4,$5,$6,$7)`,
              [
                randomUUID(),
                obligation,
                v.date,
                v.amountCentimes,
                accountId,
                'transfer:' + v.reference + ':' + direction,
                actor.id,
              ],
            );
          }
          break;
        }
        case 'holder':
          await insert('finance_holder', ['account_id', 'holder'], [v.accountId, v.holder]);
          break;
      }
      return { id: made };
    },
    { session, configure: v.action === 'configure' },
  );
}
