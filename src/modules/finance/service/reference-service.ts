import type pg from 'pg';
import { listInstruments } from '@/modules/ledger';
import type { SessionUser } from '@/modules/platform-security';
import { formatCentimes } from '@/lib/money';
import { financeRequest, type FinanceActor } from './request';
export async function getFinanceReferences(pool: pg.Pool, actor: FinanceActor, from: string, to: string) {
  return financeRequest(pool, actor, 'finance.read', async (tx) => {
    const instruments = (await listInstruments(pool, actor as SessionUser))
      .filter(
        (i) =>
          ['issued', 'received', 'deposited', 'cleared', 'bounced'].includes(i.state) &&
          i.unallocatedCentimes === i.amountCentimes,
      )
      .slice(0, 300)
      .map((i) => ({
        id: i.id,
        label: `${i.number ?? i.method} · ${i.partyName} · ${i.writtenDate ?? i.receivedDate} · ${formatCentimes(i.amountCentimes)} MAD`,
      }));
    const categories = (
      await tx.query<{ id: string; label: string; kind: 'expense' | 'pumping' }>(
        'select id,label,kind from finance.finance_category order by label',
      )
    ).rows;
    const allocations = (
      await tx.query<{ id: string; label: string }>(
        'select id,label from finance.finance_allocation order by created_at',
      )
    ).rows;
    const obligations = (
      await tx.query<{ id: string; label: string; due_date: string; amount_centimes: string }>(
        `select id,label,to_char(due_date,'YYYY-MM-DD') due_date,amount_centimes::text from finance.finance_obligation order by due_date desc limit 300`,
      )
    ).rows;
    const entries = (
      await tx.query<{
        id: string;
        entry_date: string;
        kind: string;
        amount_centimes: string;
        source_ref: string;
      }>(
        `select e.id,to_char(e.entry_date,'YYYY-MM-DD') entry_date,e.kind,e.amount_centimes::text,e.source_ref from finance.finance_entry e where e.reverses_id is null and not exists(select 1 from finance.finance_entry r where r.reverses_id=e.id) order by e.entry_date desc limit 300`,
      )
    ).rows;
    const steel = (
      await tx.query<{
        id: string;
        delivery_date: string;
        cash_centimes: string;
        purchase_centimes: string;
        cheque_count: number;
        reference: string;
      }>(
        `select id,to_char(delivery_date,'YYYY-MM-DD') delivery_date,cash_centimes::text,purchase_centimes::text,cheque_count,reference from finance.finance_steel order by delivery_date desc limit 100`,
      )
    ).rows;
    const materials = (
      await tx.query<{
        data: {
          id: string;
          date: string;
          plantId: string | null;
          componentId: string;
          componentName?: string;
          baseUnit?: string;
          qtyBase: number;
          amountCentimes: number | null;
        }[];
      }>('select finance.source_consumption($1,$2) data', [from, to])
    ).rows[0]!.data;
    const fuel = (
      await tx.query<{
        data: { id: string; date: string; truck: string; qtyMl: number; amountCentimes: number | null }[];
      }>('select finance.source_fuel($1,$2) data', [from, to])
    ).rows[0]!.data;
    return {
      fuel: fuel.filter((f) => f.amountCentimes === null),
      instruments,
      categories,
      allocations,
      obligations,
      entries,
      steel,
      materials: materials.filter((m) => m.amountCentimes === null && m.qtyBase < 0),
    };
  });
}
