import type pg from 'pg';
import { centimes } from '@/lib/money';
import { type Deadline, getCashPosition, legalDeadlines, regularizationDeadline } from '@/modules/ledger';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';
import type { BouncedFact, InstrumentFact, MoneyFacts, PlanItemFact } from '../domain';
import type { PaymentMethod } from '../domain';

interface InstrumentRow {
  id: string;
  direction: 'in' | 'out';
  method: PaymentMethod;
  amount: string;
  state: 'received' | 'deposited' | 'issued' | 'bounced';
  written: string | null;
  received: string;
  deposited_on: string | null;
  bounced_on: string | null;
  party_id: string;
  party_name: string;
  number: string | null;
  bank: string | null;
}

const labelOf = (r: InstrumentRow): string => [r.number, r.bank].filter(Boolean).join(' · ') || r.method;

/**
 * The money facts the engine reads (cash, instruments not cleared, what no allocation covers on orders and purchases,
 * bounced cheques, the legal dates), in the requester's own transaction and RLS context: owner and support only
 * (`cash.read`; DECISIONS 81). Nothing is computed here but sums the database does (what an allocation leaves uncovered).
 */
export async function loadMoneyFacts(
  appPool: pg.Pool,
  actor: SessionUser,
  today: string,
): Promise<MoneyFacts> {
  await require(appPool, actor, 'cash.read');
  const position = await getCashPosition(appPool, actor);
  const deadlines: Deadline[] = await legalDeadlines(appPool, actor, { asOf: today });

  const rows = await inRequest(appPool, actor, async (tx) => {
    const instruments = await tx.query<InstrumentRow>(
      `select i.id, i.direction, i.method, i.amount_centimes::text as amount, last.event as state,
              to_char(i.written_date, 'YYYY-MM-DD') as written, to_char(i.received_date, 'YYYY-MM-DD') as received,
              (select to_char(e.at_date, 'YYYY-MM-DD') from instrument_event e
                where e.instrument_id = i.id and e.event = 'deposited' order by e.seq desc limit 1) as deposited_on,
              (select to_char(e.at_date, 'YYYY-MM-DD') from instrument_event e
                where e.instrument_id = i.id and e.event = 'bounced' order by e.seq desc limit 1) as bounced_on,
              coalesce(i.client_id, i.supplier_id)::text as party_id, coalesce(c.name, s.name) as party_name,
              i.number, i.bank
         from payment_instrument i
         cross join lateral (select e.event from instrument_event e where e.instrument_id = i.id order by e.seq desc limit 1) last
         left join client c on c.id = i.client_id
         left join supplier s on s.id = i.supplier_id
        where last.event in ('received', 'deposited', 'issued', 'bounced')`,
    );
    const orderItems = await tx.query<{
      id: string;
      direction: 'in' | 'out';
      method: string;
      due: string;
      remaining: string;
      order_id: string;
      code: string;
      client_id: string;
      client: string;
      total: string;
      delivery: string;
    }>(
      `select p.id, p.direction, p.method, to_char(p.due_date, 'YYYY-MM-DD') as due,
              (p.amount_centimes - coalesce((select sum(a.amount_centimes) from allocation a where a.payment_plan_item_id = p.id), 0))::text as remaining,
              o.id as order_id, o.code, c.id::text as client_id, c.name as client, o.total_ttc_centimes::text as total,
              to_char(o.delivery_date, 'YYYY-MM-DD') as delivery
         from payment_plan_item p
         join sales_order o on o.id = p.order_id
         join client c on c.id = o.client_id
        where p.reverses_id is null and o.reverses_id is null
          and not exists (select 1 from payment_plan_item r where r.reverses_id = p.id)
          and not exists (select 1 from sales_order r where r.reverses_id = o.id)`,
    );
    const purchaseItems = await tx.query<{
      id: string;
      method: string;
      due: string;
      remaining: string;
      purchase_id: string;
      code: string;
      supplier_id: string;
      supplier: string;
    }>(
      `select i.id, i.method, to_char(i.due_date, 'YYYY-MM-DD') as due,
              (i.amount_centimes - coalesce((select sum(a.amount_centimes) from allocation a where a.purchase_plan_item_id = i.id), 0))::text as remaining,
              p.id as purchase_id, p.code, s.id::text as supplier_id, s.name as supplier
         from purchase_plan_item i
         join purchase p on p.id = i.purchase_id
         join supplier s on s.id = p.supplier_id
        where i.reverses_id is null and p.reverses_id is null
          and not exists (select 1 from purchase_plan_item r where r.reverses_id = i.id)
          and not exists (select 1 from purchase r where r.reverses_id = p.id)`,
    );
    return { instruments: instruments.rows, orderItems: orderItems.rows, purchaseItems: purchaseItems.rows };
  });

  const instruments: InstrumentFact[] = [];
  const bounced: BouncedFact[] = [];
  for (const r of rows.instruments) {
    if (r.state === 'bounced') {
      // Only an incoming one has a window to regularize; an outgoing bounce is ours to deal with and counts nowhere here.
      if (r.direction === 'in' && r.bounced_on)
        bounced.push({
          id: r.id,
          label: labelOf(r),
          amount: centimes(Number(r.amount)),
          partyName: r.party_name,
          bouncedOn: r.bounced_on,
          deadline: regularizationDeadline(r.bounced_on),
        });
      continue;
    }
    instruments.push({
      id: r.id,
      direction: r.direction,
      method: r.method,
      amount: centimes(Number(r.amount)),
      state: r.state,
      writtenDate: r.written,
      receivedDate: r.received,
      depositedOn: r.deposited_on,
      partyId: r.party_id,
      partyName: r.party_name,
      label: labelOf(r),
    });
  }

  const items: PlanItemFact[] = [
    ...rows.orderItems
      .filter((r) => Number(r.remaining) > 0)
      .map<PlanItemFact>((r) => ({
        id: r.id,
        direction: r.direction,
        kind: 'order',
        documentId: r.order_id,
        documentCode: r.code,
        partyId: r.client_id,
        partyName: r.client,
        dueDate: r.due,
        remaining: centimes(Number(r.remaining)),
        method: r.method,
        documentTotal: centimes(Number(r.total)),
        deliveryDate: r.delivery,
      })),
    ...rows.purchaseItems
      .filter((r) => Number(r.remaining) > 0)
      .map<PlanItemFact>((r) => ({
        id: r.id,
        direction: 'out',
        kind: 'purchase',
        documentId: r.purchase_id,
        documentCode: r.code,
        partyId: r.supplier_id,
        partyName: r.supplier,
        dueDate: r.due,
        remaining: centimes(Number(r.remaining)),
        method: r.method,
      })),
  ];

  return {
    encaisse: position.real,
    instruments,
    items,
    bounced,
    deadlines: deadlines.map((d) => ({
      kind: d.kind,
      date: d.date,
      documentCode: d.documentCode,
      partyName: d.partyName,
      amountCentimes: d.amountCentimes,
    })),
  };
}
