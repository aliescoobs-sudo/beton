import type pg from 'pg';
import { centimes } from '@/lib/money';
import { BUSINESS_TIME_ZONE } from '@/modules/clock';
import { can, inRequest, require, type SessionUser } from '@/modules/platform-security';
import { type OpenEntry, type OpeningItem, splitOpening } from '../domain/opening-items';
import { loadInvoicePayments } from './invoice-service';
import {
  buildStatement,
  type DueItem,
  type LineStatus,
  type Statement,
  type StatementFilter,
  type StatementLine,
} from '../domain/statement';

type Tx = pg.PoolClient;
export type PartyKind = 'client' | 'supplier';

export interface PartyData {
  lines: StatementLine[];
  due: DueItem[];
  /** The opening position still open after the unallocated credit: per-invoice entries when the party has items, plus the "no detail" remainder (T19c B1). */
  opening: OpenEntry[];
}

const COUNTED: readonly LineStatus[] = ['received', 'deposited', 'issued', 'cleared'];

/** Everything a statement is made of, for the given parties, in four queries (owner and support read these tables). */
export async function loadParties(
  tx: Tx,
  kind: PartyKind,
  ids: readonly string[],
): Promise<Map<string, PartyData>> {
  const data = new Map<string, PartyData>(ids.map((id) => [id, { lines: [], due: [], opening: [] }]));
  const col = kind === 'client' ? 'client_id' : 'supplier_id';
  const opening = await tx.query<{ party: string; id: string; amount: string; date: string }>(
    `select b.${col} as party, b.id, b.amount_centimes::text as amount, to_char(lo.opening_date, 'YYYY-MM-DD') as date
       from opening_party_balance b cross join ledger_opening lo where b.${col} = any($1)`,
    [ids],
  );
  // T19c B1: a party with per-invoice open items shows THOSE (one line per invoice, plus one "no detail" line for what the items do not cover);
  // a party without shows its single opening line. Never both for the same debt: the lines always add up to the party's opening line.
  const itemRows = await tx.query<{
    o_party: string;
    o_invoice_number: string;
    o_invoice_date: string;
    o_due_date: string;
    o_balance: string;
  }>(
    `select o_party, o_invoice_number, to_char(o_invoice_date, 'YYYY-MM-DD') as o_invoice_date, to_char(o_due_date, 'YYYY-MM-DD') as o_due_date,
            o_balance::text from public.opening_items_read($1, $2::uuid[])`,
    [kind, ids],
  );
  const itemsOf = new Map<string, OpeningItem[]>();
  for (const r of itemRows.rows)
    itemsOf.set(r.o_party, [
      ...(itemsOf.get(r.o_party) ?? []),
      {
        invoiceNumber: r.o_invoice_number,
        invoiceDate: r.o_invoice_date,
        dueDate: r.o_due_date,
        balanceCentimes: Number(r.o_balance),
      },
    ]);
  const lineOf = new Map<string, number>();
  for (const r of opening.rows) {
    const amount = Number(r.amount);
    lineOf.set(r.party, amount);
    const items = itemsOf.get(r.party) ?? [];
    const detailed = items.reduce((t, i) => t + i.balanceCentimes, 0);
    items.forEach((i, n) =>
      data.get(r.party)?.lines.push({
        id: `opening-item-${r.id}-${n}`,
        section: 'commercial',
        date: r.date,
        type: 'opening',
        code: i.invoiceNumber,
        status: 'booked',
        amountCentimes: centimes(i.balanceCentimes),
        counted: true,
      }),
    );
    if (amount - detailed > 0)
      data.get(r.party)?.lines.push({
        id: `opening-${r.id}`,
        section: 'commercial',
        date: r.date,
        type: 'opening',
        code: null,
        status: 'booked',
        amountCentimes: centimes(amount - detailed),
        counted: true,
      });
  }
  if (kind === 'client') {
    const orders = await tx.query<{
      id: string;
      client_id: string;
      code: string;
      total: string;
      date: string;
      booked_on: string;
      reversal: boolean;
      cancelled: boolean;
    }>(
      `select o.id, o.client_id, o.code, o.total_ttc_centimes::text as total, to_char(o.order_date, 'YYYY-MM-DD') as date,
              to_char((o.created_at at time zone $2)::date, 'YYYY-MM-DD') as booked_on,
              (o.reverses_id is not null) as reversal,
              exists (select 1 from sales_order r where r.reverses_id = o.id) as cancelled
         from sales_order o where o.client_id = any($1)`,
      [ids, BUSINESS_TIME_ZONE],
    );
    for (const o of orders.rows) {
      data.get(o.client_id)?.lines.push({
        id: `order-${o.id}`,
        section: 'commercial',
        date: o.reversal ? o.booked_on : o.date,
        type: o.reversal ? 'order_cancelled' : 'order',
        code: o.code,
        status: o.cancelled ? 'cancelled' : 'booked',
        amountCentimes: centimes(Number(o.total)),
        counted: true,
      });
    }
    const invoices = await tx.query<{
      id: string;
      client_id: string;
      number: string;
      total: string;
      date: string;
      credit: boolean;
      cancelled: boolean;
    }>(
      `select i.id, i.client_id, i.number, i.total_ttc_centimes::text as total, to_char(i.invoice_date, 'YYYY-MM-DD') as date,
              (i.credit_note_of is not null) as credit,
              exists (select 1 from invoice c where c.credit_note_of = i.id) as cancelled
         from invoice i where i.client_id = any($1)`,
      [ids],
    );
    const payments = await loadInvoicePayments(tx);
    // An invoice documents what the order already booked: shown in the commercial section, never added to the balance.
    for (const i of invoices.rows) {
      data.get(i.client_id)?.lines.push({
        id: `invoice-${i.id}`,
        section: 'commercial',
        date: i.date,
        type: i.credit ? 'credit_note' : 'invoice',
        code: i.number,
        status: i.cancelled ? 'cancelled' : 'booked',
        amountCentimes: centimes(Number(i.total)),
        counted: false,
        ...(payments.get(i.id) ? { payment: payments.get(i.id)?.state } : {}),
      });
    }
    // The avoirs for concrete refused after it was billed: commercial lines that count (they lower what the client owes).
    const avoirs = await tx.query<{
      id: string;
      client_id: string;
      number: string;
      ttc: string;
      date: string;
    }>(
      `select a.id, a.client_id, a.number, a.total_ttc_centimes::text as ttc, to_char(a.avoir_date, 'YYYY-MM-DD') as date
         from avoir a where a.client_id = any($1)`,
      [ids],
    );
    for (const a of avoirs.rows) {
      data.get(a.client_id)?.lines.push({
        id: `avoir-${a.id}`,
        section: 'commercial',
        date: a.date,
        type: 'avoir',
        code: a.number,
        status: 'booked',
        amountCentimes: centimes(-Number(a.ttc)),
        counted: true,
      });
    }
    const items = await tx.query<{
      client_id: string;
      due: string;
      amount: string;
      covered: string;
      plant_id: string | null;
    }>(
      `select o.client_id, o.plant_id, to_char(i.due_date, 'YYYY-MM-DD') as due, i.amount_centimes::text as amount,
              coalesce((select sum(a.amount_centimes) from allocation a where a.payment_plan_item_id = i.id), 0)::text as covered
         from payment_plan_item i join sales_order o on o.id = i.order_id
        where o.client_id = any($1) and i.reverses_id is null and o.reverses_id is null
          and not exists (select 1 from sales_order r where r.reverses_id = o.id)`,
      [ids],
    );
    for (const i of items.rows) {
      data.get(i.client_id)?.due.push({
        dueDate: i.due,
        amountCentimes: centimes(Number(i.amount)),
        coveredCentimes: centimes(Number(i.covered)),
        plantId: i.plant_id,
      });
    }
  }
  if (kind === 'supplier') {
    const purchases = await tx.query<{
      id: string;
      supplier_id: string;
      code: string;
      total: string;
      date: string;
      booked_on: string;
      reversal: boolean;
      cancelled: boolean;
      by_invoice: boolean;
    }>(
      `select p.id, p.supplier_id, p.code, p.total_ttc_centimes::text as total, to_char(p.order_date, 'YYYY-MM-DD') as date,
              to_char((p.created_at at time zone $2)::date, 'YYYY-MM-DD') as booked_on,
              (p.payable_source = 'invoice') as by_invoice,
              (p.reverses_id is not null) as reversal,
              exists (select 1 from purchase r where r.reverses_id = p.id) as cancelled
         from purchase p where p.supplier_id = any($1)`,
      [ids, BUSINESS_TIME_ZONE],
    );
    for (const p of purchases.rows) {
      data.get(p.supplier_id)?.lines.push({
        id: `purchase-${p.id}`,
        section: 'commercial',
        date: p.reversal ? p.booked_on : p.date,
        type: p.reversal ? 'purchase_cancelled' : 'purchase',
        code: p.code,
        status: p.cancelled ? 'cancelled' : 'booked',
        amountCentimes: centimes(Number(p.total)),
        // An order whose payable comes from its invoices is a commitment, not a debt: the approved invoices below are.
        counted: !p.by_invoice,
      });
    }
    // The supplier invoices approved for payment: what we owe, as soon as the owner approved them.
    const approved = await tx.query<{
      id: string;
      supplier_id: string;
      code: string;
      total: string;
      date: string;
    }>(
      `select s.id, s.supplier_id, s.code, s.total_ttc_centimes::text as total, to_char(s.invoice_date, 'YYYY-MM-DD') as date
         from supplier_invoice s
        where s.supplier_id = any($1)
          and (select e.event from supplier_invoice_event e where e.supplier_invoice_id = s.id order by e.seq desc limit 1) = 'approved'`,
      [ids],
    );
    for (const s of approved.rows) {
      data.get(s.supplier_id)?.lines.push({
        id: `supplier-invoice-${s.id}`,
        section: 'commercial',
        date: s.date,
        type: 'supplier_invoice',
        code: s.code,
        status: 'booked',
        amountCentimes: centimes(Number(s.total)),
        counted: true,
      });
    }
    const pitems = await tx.query<{
      supplier_id: string;
      due: string;
      amount: string;
      covered: string;
      plant_id: string | null;
    }>(
      `select p.supplier_id, p.plant_id, to_char(i.due_date, 'YYYY-MM-DD') as due, i.amount_centimes::text as amount,
              coalesce((select sum(a.amount_centimes) from allocation a where a.purchase_plan_item_id = i.id), 0)::text as covered
         from purchase_plan_item i join purchase p on p.id = i.purchase_id
        where p.supplier_id = any($1) and i.reverses_id is null and p.reverses_id is null
          and not exists (select 1 from purchase r where r.reverses_id = p.id)`,
      [ids],
    );
    for (const i of pitems.rows) {
      data.get(i.supplier_id)?.due.push({
        dueDate: i.due,
        amountCentimes: centimes(Number(i.amount)),
        coveredCentimes: centimes(Number(i.covered)),
        plantId: i.plant_id,
      });
    }
  }
  const instruments = await tx.query<{
    id: string;
    party: string;
    number: string | null;
    method: string;
    amount: string;
    date: string;
    state: LineStatus;
    allocated: string;
  }>(
    `select i.id, i.${col} as party, i.number, i.method, i.amount_centimes::text as amount,
            to_char(i.received_date, 'YYYY-MM-DD') as date, last.event as state,
            coalesce((select sum(a.amount_centimes) from allocation a where a.instrument_id = i.id), 0)::text as allocated
       from payment_instrument i
       cross join lateral (select e.event from instrument_event e where e.instrument_id = i.id order by e.seq desc limit 1) last
      where i.${col} = any($1) and i.direction = $2`,
    [ids, kind === 'client' ? 'in' : 'out'],
  );
  // the credit no plan item took: what the party paid (counted) minus what the allocations already spent on plan items
  const credit = new Map<string, number>();
  for (const p of instruments.rows) {
    if (COUNTED.includes(p.state))
      credit.set(p.party, (credit.get(p.party) ?? 0) + Math.max(0, Number(p.amount) - Number(p.allocated)));
    data.get(p.party)?.lines.push({
      id: `payment-${p.id}`,
      section: 'financial',
      date: p.date,
      type: 'payment',
      code: p.number,
      status: p.state,
      amountCentimes: centimes(-Number(p.amount)),
      counted: COUNTED.includes(p.state),
    });
  }
  // the opening position that is still open: the credit goes to the oldest opening items first (the rule is in the domain), then to the "no detail" part
  for (const [party, line] of lineOf) {
    const d = data.get(party);
    if (!d) continue;
    const split = splitOpening(line, itemsOf.get(party) ?? [], credit.get(party) ?? 0);
    d.opening.push(...split.items);
    if (split.remainderCentimes > 0)
      d.opening.push({ dueDate: null, openCentimes: split.remainderCentimes, origin: 'opening_line' });
    const raw = new Map((itemsOf.get(party) ?? []).map((i) => [i.invoiceNumber, i.balanceCentimes]));
    for (const e of split.items)
      d.due.push({
        dueDate: e.dueDate as string,
        amountCentimes: centimes(raw.get(e.invoiceNumber as string) ?? e.openCentimes),
        coveredCentimes: centimes((raw.get(e.invoiceNumber as string) ?? e.openCentimes) - e.openCentimes),
      });
  }
  return data;
}

export interface PartyStatement {
  partyId: string;
  code: string;
  name: string;
  statement: Statement;
}

async function statementOf(
  appPool: pg.Pool,
  actor: SessionUser,
  kind: PartyKind,
  partyId: string,
  filter: StatementFilter,
  today: string,
): Promise<PartyStatement | null> {
  await require(appPool, actor, kind === 'client' ? 'statements.client' : 'statements.supplier');
  return inRequest(appPool, actor, async (tx) => {
    const table = kind === 'client' ? 'client' : 'supplier';
    const party = await tx.query<{ id: string; code: string; name: string }>(
      `select id, code, name from ${table} where id = $1`,
      [partyId],
    );
    const row = party.rows[0];
    if (!row) return null;
    const data = (await loadParties(tx, kind, [partyId])).get(partyId) as PartyData;
    return {
      partyId,
      code: row.code,
      name: row.name,
      statement: buildStatement(data.lines, data.due, today, filter),
    };
  });
}

/** The statement of one client, owner and support only. A malformed id is "not found". */
export function getClientStatement(
  appPool: pg.Pool,
  actor: SessionUser,
  clientId: string,
  filter: StatementFilter,
  deps: { today: string },
) {
  return statementOf(appPool, actor, 'client', clientId, filter, deps.today).catch(notFoundOnMalformed);
}

export function getSupplierStatement(
  appPool: pg.Pool,
  actor: SessionUser,
  supplierId: string,
  filter: StatementFilter,
  deps: { today: string },
) {
  return statementOf(appPool, actor, 'supplier', supplierId, filter, deps.today).catch(notFoundOnMalformed);
}

function notFoundOnMalformed(error: unknown): null {
  if ((error as { code?: string }).code === '22P02') return null;
  throw error;
}

export interface AccountRow {
  partyId: string;
  kind: PartyKind;
  code: string;
  name: string;
  balanceCentimes: number;
  lateCentimes: number;
  nextDueDate: string | null;
  hasDispute: boolean;
}

/** Every active client and supplier with what they owe, what is late and the next due date (the "Comptes" list). */
export async function listAccounts(
  appPool: pg.Pool,
  actor: SessionUser,
  deps: { today: string },
): Promise<AccountRow[]> {
  // D245: each role lists the side it may read (the database refuses the other side's rows anyway)
  const sides = (['client', 'supplier'] as const).filter((k) =>
    can(actor.role, k === 'client' ? 'statements.client' : 'statements.supplier'),
  );
  if (sides.length === 0) await require(appPool, actor, 'statements.read');
  return inRequest(appPool, actor, async (tx) => {
    const rows: AccountRow[] = [];
    for (const kind of sides) {
      const parties = await tx.query<{ id: string; code: string; name: string }>(
        `select id, code, name from ${kind} where status = 'active' order by lower(name)`,
      );
      const ids = parties.rows.map((p) => p.id);
      const data = await loadParties(tx, kind, ids);
      const disputed = new Set(
        (
          await tx.query<{ id: string }>(
            `select distinct i.${kind}_id as id from payment_instrument i join instrument_event e on e.instrument_id = i.id and e.event = 'disputed'
              where i.${kind}_id = any($1)`,
            [ids],
          )
        ).rows.map((r) => r.id),
      );
      for (const p of parties.rows) {
        const d = data.get(p.id) as PartyData;
        const st = buildStatement(d.lines, d.due, deps.today);
        const s = st.summary;
        rows.push({
          partyId: p.id,
          kind,
          code: p.code,
          name: p.name,
          balanceCentimes: Number(st.closing),
          lateCentimes: Number(s.late),
          nextDueDate: s.nextDueDate,
          hasDispute: disputed.has(p.id),
        });
      }
    }
    return rows;
  });
}
