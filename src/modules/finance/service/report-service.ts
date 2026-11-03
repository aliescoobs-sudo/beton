import type pg from 'pg';
import { listPlants } from '@/modules/master-data';
import type { SessionUser } from '@/modules/platform-security';
import { integer, subtract, sum } from '../domain/money';
import { cashForecast, type CashFlow } from '../domain/forecast';
import { managementReport, type ResultFact } from '../domain/report';
import { validDate } from '../domain/period';
import { canFinance } from '../domain/permissions';
import { financeRequest, FinanceUnavailable, type FinanceActor } from './request';
interface SourceSale extends ResultFact {
  confirmed: boolean;
}
interface SourceMaterial extends Omit<ResultFact, 'amountCentimes'> {
  amountCentimes: number | null;
  componentId: string;
  componentName?: string;
  baseUnit?: string;
  qtyBase: number;
}
export function validRange(from: string, to: string, maxDays = 366) {
  if (
    !validDate(from) ||
    !validDate(to) ||
    from > to ||
    (Date.parse(to) - Date.parse(from)) / 86400000 > maxDays
  )
    throw new Error('INVALID_PERIOD');
}
export async function getFinanceReport(pool: pg.Pool, actor: FinanceActor, from: string, to: string) {
  validRange(from, to);
  if (!canFinance(actor.role, 'finance.read')) throw new FinanceUnavailable();
  // R1 public API. app_admin support is completed by the lead's R2; no role impersonation here.
  const plants = await listPlants(pool, actor as SessionUser);
  return financeRequest(pool, actor, 'finance.read', async (tx) => {
    const sales = (
      await tx.query<{ data: SourceSale[] }>('select finance.source_sales($1,$2) data', [from, to])
    ).rows[0]!.data;
    const materials = (
      await tx.query<{ data: SourceMaterial[] }>('select finance.source_consumption($1,$2) data', [from, to])
    ).rows[0]!.data;
    const fuel = (
      await tx.query<{ data: (Omit<ResultFact, 'amountCentimes'> & { amountCentimes: number | null })[] }>(
        'select finance.source_fuel($1,$2) data',
        [from, to],
      )
    ).rows[0]!.data;
    const entries = (
      await tx.query<{
        id: string;
        date: string;
        plant_id: string | null;
        kind: ResultFact['kind'];
        amount: string;
        weights: Record<string, number> | null;
      }>(
        `select e.id,to_char(e.entry_date,'YYYY-MM-DD') date,e.plant_id,e.kind,e.amount_centimes::text amount,a.weights from finance.finance_entry e left join finance.finance_allocation a on a.id=e.allocation_id where e.entry_date between $1 and $2`,
        [from, to],
      )
    ).rows;
    const setting = (
      await tx.query<{ leasing_treatment: 'expense' | 'principal_interest' }>(
        `select leasing_treatment from finance.finance_setting order by created_at desc,id desc limit 1`,
      )
    ).rows[0]!;
    const facts: ResultFact[] = [
      ...sales.filter((s) => s.confirmed),
      ...fuel.filter((f): f is ResultFact => f.amountCentimes !== null),
      ...materials.filter((s): s is SourceMaterial & { amountCentimes: number } => s.amountCentimes !== null),
      ...entries.map((e) => ({
        id: e.id,
        date: e.date,
        plantId: e.plant_id,
        kind: e.kind,
        amountCentimes: integer(Number(e.amount)),
        allocation: e.weights,
      })),
    ];
    return managementReport({
      from,
      to,
      plants: plants.map((p) => ({ id: p.id, name: p.name })),
      facts,
      leasingTreatment: setting.leasing_treatment,
      missingValuations:
        materials.filter((s) => s.amountCentimes === null).length +
        fuel.filter((f) => f.amountCentimes === null).length,
      excludedRevenueCentimes: sum(sales.filter((s) => !s.confirmed).map((s) => s.amountCentimes)),
      excludedRevenueCount: sales.filter((s) => !s.confirmed).length,
    });
  });
}
export async function getFinanceCash(pool: pg.Pool, actor: FinanceActor, from: string, to: string) {
  validRange(from, to, 730);
  return financeRequest(pool, actor, 'finance.read', async (tx) => {
    const before = new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10);
    const accounts = (
      await tx.query<{ data: { id: string; label: string; kind: string; balanceCentimes: number }[] }>(
        'select finance.source_accounts($1) data',
        [before],
      )
    ).rows[0]!.data;
    const payments = (
      await tx.query<{ account_id: string; amount: string }>(
        `select p.account_id, (case o.direction when 'in' then p.amount_centimes else -p.amount_centimes end)::text amount from finance.finance_payment p join finance.finance_obligation o on o.id=p.obligation_id where p.instrument_id is null and p.payment_date<$1`,
        [from],
      )
    ).rows;
    const holders = (
      await tx.query<{ account_id: string; holder: string }>(
        'select account_id,holder from finance.finance_holder',
      )
    ).rows;
    const held = accounts.map((a) => ({
      ...a,
      holder: holders.find((h) => h.account_id === a.id)?.holder ?? 'unassigned',
      balanceCentimes: sum([
        a.balanceCentimes,
        ...payments.filter((p) => p.account_id === a.id).map((p) => integer(Number(p.amount))),
      ]),
    }));
    const obligations = (
      await tx.query<{
        id: string;
        date: string;
        direction: 'in' | 'out';
        amount: string;
        steel_date: string | null;
      }>(
        `select o.id,to_char(o.due_date,'YYYY-MM-DD') date,o.direction,(select to_char(s.delivery_date,'YYYY-MM-DD') from finance.finance_steel s where o.source_ref like 'steel:cheque:'||s.id::text||':%') steel_date,(o.amount_centimes-coalesce((select sum(p.amount_centimes) from finance.finance_payment p where p.obligation_id=o.id and p.instrument_id is null),0))::text amount from finance.finance_obligation o where o.entry_id is null or not exists(select 1 from finance.finance_entry r where r.reverses_id=o.entry_id)`,
      )
    ).rows;
    const flows: CashFlow[] = (
      await tx.query<{ data: CashFlow[] }>('select finance.source_flows() data')
    ).rows[0]!.data.filter((f) => f.amountCentimes > 0);
    const own = obligations
      .filter((o) => Number(o.amount) > 0)
      .map((o): CashFlow => ({
        id: 'finance:' + o.id,
        commitmentId: o.id,
        date: o.date,
        direction: o.direction,
        amountCentimes: integer(Number(o.amount)),
        ...(o.steel_date ? { method: 'cheque', issuedDate: o.steel_date } : {}),
        source: 'schedule',
      }));
    // Cleared instruments are already in ledger cash; scheduled portions settled through them are removed by the door below.
    const cleared = (
      await tx.query<{ obligation_id: string; amount: string }>(
        `select l.obligation_id,sum(p.amount_centimes)::text amount from finance.finance_instrument_link l cross join lateral finance.link_state(l.instrument_id) p where p.state='cleared' group by l.obligation_id`,
      )
    ).rows;
    for (const flow of own) {
      const c = cleared.find((c) => c.obligation_id === flow.commitmentId);
      if (c) flow.amountCentimes = subtract(flow.amountCentimes, integer(Number(c.amount)));
    }
    const actual = (
      await tx.query<{ id: string; date: string; direction: 'in' | 'out'; amount: string }>(
        `select p.id,to_char(p.payment_date,'YYYY-MM-DD') date,o.direction,p.amount_centimes::text amount from finance.finance_payment p join finance.finance_obligation o on o.id=p.obligation_id where p.instrument_id is null and p.payment_date between $1 and $2`,
        [from, to],
      )
    ).rows.map((p): CashFlow => ({
      id: 'actual:' + p.id,
      commitmentId: 'actual:' + p.id,
      date: p.date,
      direction: p.direction,
      amountCentimes: integer(Number(p.amount)),
      source: 'schedule',
    }));
    const actualLedger = (
      await tx.query<{ data: CashFlow[] }>('select finance.source_movements($1) data', [from])
    ).rows[0]!.data;
    const combined = [...actualLedger, ...flows, ...own.filter((f) => f.amountCentimes > 0), ...actual],
      openingCentimes = sum(held.map((a) => a.balanceCentimes));
    return {
      accounts: held,
      openingCentimes,
      flows: combined,
      scheduled: cashForecast(openingCentimes, from, to, combined),
      conservative: cashForecast(openingCentimes, from, to, combined, true),
    };
  });
}
